import { defineTool, k8sLabel, Level, ToolError } from "@ops-agent/mcp-server/shared";
import { z } from "zod";
import { deploymentPath } from "../../adapters/k8s-write.js";
import type { WriteContext } from "../../types.js";
import {
  assertWithinRateLimits,
  type Deployment,
  type DeploymentList,
  podSelector,
  summarizeDeployment,
} from "./deployment.js";
import {
  checkRollout,
  listPods,
  type PodSummary,
  ROLLOUT_TIMING,
  type RolloutOutcome,
  type RolloutTarget,
} from "./rollout-check.js";

const NAME = "k8s_rollout_restart";
const MAX_PODS_SHOWN = 10;
// The second round holds the post-check; the margin covers the reads and the patch around it.
const TIMEOUT_MS = ROLLOUT_TIMING.rolledOutWithinMs + ROLLOUT_TIMING.healthyForMs + 60_000;

/** What round 1 saw, sealed into the approval: round 2 patches only if the deployment has not changed since. */
const Facts = z.object({ resourceVersion: z.string() });

const input = {
  namespace: k8sLabel.describe("Namespace of the deployment; must be one this server may act in."),
  deployment: k8sLabel.describe("Name of the deployment to restart."),
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe("Why a restart fixes this, from what you observed; shown to the human who approves it."),
};
type Args = Readonly<z.infer<z.ZodObject<typeof input>>>;

export const rolloutRestart = defineTool({
  name: NAME,
  level: Level.Change,
  title: "Restart a deployment (a human approves it first)",
  description:
    "Restarts a deployment's pods, like `kubectl rollout restart`, after a human approves it in a confirmation " +
    "form. Use it only when new pods would start in a better state than the current ones: a Secret or ConfigMap " +
    "changed since they started, a dependency that has since recovered, or pods stuck in a bad state. It does not " +
    "fix a crash caused by the image or its configuration: new pods fail the same way. Returns `not_approved` if the " +
    "human says no, otherwise the rollout's outcome: `healthy`, `rolled_out_unhealthy`, `not_rolled_out`, or " +
    "`unknown` when the cluster could not be read after the restart.",
  input,
  timeoutMs: TIMEOUT_MS,
  async run(args, ctx: WriteContext) {
    const call = { tool: NAME, args };
    const decision = ctx.approvals.decide(call, ctx.round, Facts);
    if (decision.kind === "unanswered") return propose(args, ctx);
    const audit = auditOf(args, ctx);
    if (decision.kind === "not_approved") {
      ctx.log("write_action", { ...audit, approved: false, why: decision.why });
      return { status: "not_approved", why: decision.why };
    }
    ctx.log("write_action", { ...audit, approved: true });
    const result = await restart(args, ctx, decision.facts.resourceVersion);
    ctx.log("write_action_result", { ...audit, status: result.rollout.status });
    return result;
  },
});

/** Round 1: everything the human needs to decide, checked before they are asked. */
async function propose(args: Args, ctx: WriteContext) {
  if (!ctx.k8s.namespaces.includes(args.namespace)) {
    throw new ToolError("namespace_not_allowed", `namespace ${args.namespace} is not in OPS_K8S_NAMESPACES`);
  }
  const deployment = await readDeployment(ctx, args);
  assertWithinRateLimits(deployment, await allDeployments(ctx), ctx.now());
  const pods = await listPods(ctx, args.namespace, podSelector(deployment));
  const resourceVersion = deployment.metadata.resourceVersion;
  const restartedAt = ctx.now().toISOString();
  const dryRun = {
    namespace: args.namespace,
    name: args.deployment,
    resourceVersion,
    restartedAt,
    mode: "dry_run",
  } as const;
  // The API server checks the same patch without applying it, so an approval is never spent on a patch it refuses.
  await ctx.k8s.restartDeployment(dryRun, ctx.signal);
  ctx.log("write_proposal", { ...auditOf(args, ctx), dry_run: "accepted" });
  const message = describeProposal(args, deployment, pods);
  return ctx.approvals.ask({ tool: NAME, args }, message, { resourceVersion });
}

/** Round 2, approved: patch with the version the human saw, then watch the rollout. */
async function restart(args: Args, ctx: WriteContext, resourceVersion: string) {
  const restartedAt = ctx.now().toISOString();
  const patch = {
    namespace: args.namespace,
    name: args.deployment,
    resourceVersion,
    restartedAt,
    mode: "apply",
  } as const;
  // A form stays open for minutes, and other restarts may have been approved since this one was proposed. The check
  // and the patch run as one, so two approvals side by side cannot both fit under the last free place.
  const patched = await ctx.exclusive(async () => {
    assertWithinRateLimits(await readDeployment(ctx, args), await allDeployments(ctx), ctx.now());
    return ctx.k8s.restartDeployment<Deployment>(patch, ctx.signal);
  });
  const target = {
    namespace: args.namespace,
    name: args.deployment,
    generation: patched.metadata.generation ?? 0,
    selector: podSelector(patched),
  };
  const rollout = await checkAfterRestart(ctx, target, auditOf(args, ctx), restartedAt);
  return { status: "restarted", restarted_at: restartedAt, rollout };
}

/** The restart has happened: a check that fails must not hide that, so its errors become an `unknown` outcome. */
async function checkAfterRestart(
  ctx: WriteContext,
  target: RolloutTarget,
  audit: ReturnType<typeof auditOf>,
  restartedAt: string,
): Promise<RolloutOutcome> {
  try {
    return await checkRollout(ctx, target);
  } catch (err) {
    // A timeout or a cancel ends the call itself and the registry reports it; the audit still records the restart.
    if (ctx.signal.aborted) {
      ctx.log("write_action_result", { ...audit, status: "check_aborted", restarted_at: restartedAt });
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    ctx.log("rollout_check_failed", { tool: NAME, namespace: target.namespace, error: ctx.redact(detail) });
    const why = err instanceof ToolError ? err.message : "the cluster could not be read; details are in the server log";
    return { status: "unknown", why };
  }
}

/** The local audit line: which action, and the agent's reason, redacted like everything else that leaves a tool. */
function auditOf(args: Args, ctx: WriteContext) {
  return { tool: NAME, namespace: args.namespace, deployment: args.deployment, reason: ctx.redact(args.reason) };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const readDeployment = (ctx: WriteContext, args: Args) =>
  ctx.k8s.getJson<Deployment>(deploymentPath(args.namespace, args.deployment), ctx.signal);

async function allDeployments(ctx: WriteContext): Promise<Deployment[]> {
  const listIn = (namespace: string) =>
    ctx.k8s.getJson<DeploymentList>(`/apis/apps/v1/namespaces/${namespace}/deployments`, ctx.signal);
  const lists = await Promise.all(ctx.k8s.namespaces.map(listIn));
  return lists.flatMap((list) => list.items);
}

/**
 * The form: what the server read itself, plus the agent's reason marked as such. Container states show reasons
 * only, never their messages: termination messages are written by the app, and a log line must not argue its case.
 */
export function describeProposal(args: Args, deployment: Deployment, pods: readonly PodSummary[]): string {
  const summary = summarizeDeployment(deployment);
  const shown = pods.slice(0, MAX_PODS_SHOWN).map(describePod);
  const more = pods.length > MAX_PODS_SHOWN ? [`- and ${pods.length - MAX_PODS_SHOWN} more`] : [];
  return [
    `Restart deployment ${summary.name}? (kubectl rollout restart: new pods replace the current ones)`,
    "",
    // One line: a reason with line breaks could otherwise draw lines that look like the server's own evidence.
    `The agent's reason: ${oneLine(args.reason)}`,
    "",
    `Deployment: ${summary.ready} ready, ${summary.updated} updated, last restart: ${summary.last_restart}`,
    `Pods (${pods.length}):`,
    ...shown,
    ...more,
    "",
    "Dry run: the API server accepts the change.",
  ].join("\n");
}

function describePod(pod: PodSummary): string {
  const line = `- ${pod.name}: ${pod.phase}, ready ${pod.ready}, ${pod.restarts} restarts`;
  const troubled = pod.containers.find((container) => container.state !== "running" || !container.ready);
  if (troubled === undefined) return line;
  const reason = "reason" in troubled ? troubled.reason : undefined;
  const why = reason ? ` (${reason})` : "";
  return `${line}, ${troubled.name} ${troubled.state}${why}`;
}
