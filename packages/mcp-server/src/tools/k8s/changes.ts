import { z } from "zod";
import { describeSpan } from "../../lib/units.js";
import { defineTool, type K8sClient, Level } from "../../types.js";
import { type NetworkPolicy, type PolicyChange, policyChange } from "./network-policies.js";
import { type ImageDrift, imageDrift, type PodImages, type ReplicaSet, type Rollout, rolloutsOf } from "./rollouts.js";
import { allowedNamespaces, type Condition, conditionOf, customResourcePath, k8sLabel, nsPath } from "./shared.js";

/** Only status and ownership: a Job's pod template holds env, command and args like a pod spec. */
interface Job {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind: string; readonly name: string }>;
  };
  readonly status?: {
    readonly startTime?: string;
    readonly completionTime?: string;
    readonly active?: number;
    readonly conditions?: readonly Condition[];
  };
}

type ChangeKind = Rollout["kind"] | "job" | "image_drift" | "network_policy";

interface Change {
  /** Unknown for a rollback (the API keeps no time for it) and for image drift. */
  readonly at_ago_s: number | null;
  readonly kind: ChangeKind;
  readonly namespace: string;
  readonly object: string;
  readonly change: string;
  readonly current?: true;
}

const MAX_CHANGES = 50;

const agoSeconds = (time: number, now: Date) => Math.max(0, Math.round((now.getTime() - time) / 1000));

function rolloutChange(rollout: Rollout, now: Date): Change {
  const at = rollout.kind === "rollback" ? null : agoSeconds(rollout.createdAt, now);
  const what =
    rollout.kind === "rollback"
      ? `rolled back at an unknown time to an earlier template: ${rollout.change}`
      : rollout.change;
  return {
    at_ago_s: at,
    kind: rollout.kind,
    namespace: rollout.namespace,
    object: `Deployment/${rollout.deployment}`,
    change: `revision ${rollout.revision}, ${what}`,
    ...(rollout.current ? { current: true } : {}),
  };
}

/** In the window; a rollback keeps no time of its own, so only the current one is shown, as what runs now. */
function isRecent(rollout: Rollout, cutoff: number): boolean {
  if (rollout.kind === "rollback") return rollout.current;
  return rollout.createdAt >= cutoff;
}

const failedCondition = (job: Job) => {
  const failed = conditionOf(job.status?.conditions, "Failed");
  return failed?.status === "True" ? failed : undefined;
};

function jobOutcome(job: Job, now: Date): string {
  const failed = failedCondition(job);
  if (failed) return `failed (${failed.reason ?? "no reason"})`;
  const started = Date.parse(job.status?.startTime ?? "");
  const completed = Date.parse(job.status?.completionTime ?? "");
  if (!Number.isNaN(completed)) return `succeeded in ${describeSpan(Math.round((completed - started) / 1000))}`;
  if ((job.status?.active ?? 0) > 0) return `running for ${describeSpan(agoSeconds(started, now))}`;
  return "not running, no outcome yet";
}

function jobChange(job: Job, now: Date): Change {
  const owner = job.metadata.ownerReferences?.[0];
  const from = owner ? ` (from ${owner.kind}/${owner.name})` : "";
  return {
    at_ago_s: agoSeconds(Date.parse(job.status?.startTime ?? ""), now),
    kind: "job",
    namespace: job.metadata.namespace,
    object: `Job/${job.metadata.name}`,
    change: `${jobOutcome(job, now)}${from}`,
  };
}

function driftChange(drift: ImageDrift): Change {
  return {
    at_ago_s: null,
    kind: "image_drift",
    namespace: drift.namespace,
    object: `ReplicaSet/${drift.replicaSet}`,
    change: `container ${drift.container} runs ${drift.digests.length} builds of ${drift.image}: ${drift.digests.join(", ")}`,
  };
}

function networkPolicyChange(policy: PolicyChange, now: Date): Change {
  return {
    at_ago_s: agoSeconds(policy.at, now),
    kind: "network_policy",
    namespace: policy.namespace,
    object: `NetworkPolicy/${policy.name}`,
    change: policy.change,
  };
}

// Undated changes (image drift, a current rollback) are about what runs now, so they lead.
const undatedThenNewest = (a: Change, b: Change) => (a.at_ago_s ?? 0) - (b.at_ago_s ?? 0);

/** Failed Jobs and mixed builds are trouble in themselves; rollouts are leads, not problems. */
const problemOf = (change: Change) => `${change.namespace}/${change.object}: ${change.change}`;

interface NamespaceState {
  readonly replicaSets: readonly ReplicaSet[];
  readonly jobs: readonly Job[];
  readonly pods: readonly PodImages[];
  readonly policies: readonly NetworkPolicy[];
}

async function readNamespace(k8s: K8sClient, namespace: string, signal: AbortSignal): Promise<NamespaceState> {
  const [replicaSets, jobs, pods, policies] = await Promise.all([
    k8s.getJson<{ items: ReplicaSet[] }>(customResourcePath("apps/v1", namespace, "replicasets"), signal),
    k8s.getJson<{ items: Job[] }>(customResourcePath("batch/v1", namespace, "jobs"), signal),
    k8s.getJson<{ items: PodImages[] }>(`${nsPath(namespace)}/pods`, signal),
    k8s.getJson<{ items: NetworkPolicy[] }>(
      customResourcePath("networking.k8s.io/v1", namespace, "networkpolicies"),
      signal,
    ),
  ]);
  return { replicaSets: replicaSets.items, jobs: jobs.items, pods: pods.items, policies: policies.items };
}

export const k8sChanges = defineTool({
  name: "k8s_changes",
  level: Level.Read,
  requires: ["k8s"],
  title: "Kubernetes: what changed",
  description:
    "What changed in the allowed namespaces, newest first: deployment rollouts (a new image; a restart; or the " +
    "same images with a changed pod template, i.e. env, config, resources or probes), rollbacks, Jobs that ran " +
    "(e.g. a database migration) and how they ended, NetworkPolicies created or changed (with which traffic they " +
    "now allow; a deleted one leaves no trace), and pods of one ReplicaSet running different builds of the " +
    "same image tag. Most incidents start right after a change: compare `at_ago_s` with when the trouble began. " +
    "A change close in time is a lead, not proof: confirm it in logs or metrics before naming it the cause. " +
    "Env and config values are never returned.",
  input: {
    namespace: k8sLabel.optional(),
    since_minutes: z.number().int().min(1).max(10_080).default(1_440),
  },
  timeoutMs: 8_000,

  async run({ namespace, since_minutes }, { k8s, signal }) {
    const now = new Date();
    const cutoff = now.getTime() - since_minutes * 60_000;
    const read = await Promise.all(allowedNamespaces(k8s, namespace).map((ns) => readNamespace(k8s, ns, signal)));

    const rollouts = rolloutsOf(read.flatMap((ns) => ns.replicaSets))
      .filter((rollout) => isRecent(rollout, cutoff))
      .map((rollout) => rolloutChange(rollout, now));
    const recentJobs = read.flatMap((ns) => ns.jobs).filter((job) => Date.parse(job.status?.startTime ?? "") >= cutoff);
    const jobs = recentJobs.map((job) => ({ change: jobChange(job, now), failed: failedCondition(job) !== undefined }));
    const failedJobs = jobs.filter((job) => job.failed).map((job) => job.change);
    const drifts = imageDrift(read.flatMap((ns) => ns.pods)).map(driftChange);
    const policies = read
      .flatMap((ns) => ns.policies.map(policyChange))
      .filter((policy) => policy.at >= cutoff)
      .map((policy) => networkPolicyChange(policy, now));

    const datedChanges = [...rollouts, ...jobs.map((job) => job.change), ...policies];
    const changes = [...drifts, ...datedChanges].toSorted(undatedThenNewest);
    const problems = [...failedJobs, ...drifts].map(problemOf);
    return { total: changes.length, changes: changes.slice(0, MAX_CHANGES), problems };
  },
});
