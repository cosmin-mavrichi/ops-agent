import { ToolError } from "@ops-agent/mcp-server/shared";
import { RESTARTED_AT } from "../../adapters/k8s-write.js";

// Only the fields the restart reads. The pod template also holds containers with env, command and args, which can
// carry secrets; they are deliberately absent here so no code path can return them.
export interface Deployment {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly resourceVersion: string;
    readonly generation?: number;
  };
  readonly spec: {
    readonly replicas?: number;
    readonly selector: { readonly matchLabels?: Readonly<Record<string, string>>; readonly matchExpressions?: unknown };
    readonly template: { readonly metadata?: { readonly annotations?: Readonly<Record<string, string>> } };
  };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly readyReplicas?: number;
    readonly availableReplicas?: number;
  };
}

export interface DeploymentList {
  readonly items: readonly Deployment[];
}

export interface RateLimits {
  /** A deployment restarted more recently than this is not restarted again. */
  readonly perDeploymentMs: number;
  /**
   * At most this many deployments restarted in the last hour, across the namespaces. It counts deployments, from
   * each one's latest restart: one deployment restarted twice counts once (the per-deployment limit spaces those).
   */
  readonly perHour: number;
}

export const RATE_LIMITS: RateLimits = { perDeploymentMs: 10 * 60_000, perHour: 5 };
const HOUR_MS = 60 * 60_000;

export const restartedAtOf = (deployment: Deployment): string | undefined =>
  deployment.spec.template.metadata?.annotations?.[RESTARTED_AT];

/** The evidence a human sees about the deployment: counts and dates, nothing from the pod template. */
export function summarizeDeployment(deployment: Deployment) {
  const status = deployment.status ?? {};
  const wanted = deployment.spec.replicas ?? 1;
  return {
    name: `${deployment.metadata.namespace}/${deployment.metadata.name}`,
    replicas: wanted,
    ready: `${status.readyReplicas ?? 0}/${wanted}`,
    updated: status.updatedReplicas ?? 0,
    available: status.availableReplicas ?? 0,
    last_restart: describeRestart(restartedAtOf(deployment)),
  };
}

/** The annotation is free text anyone who may patch the deployment can set: show it only as a date. */
function describeRestart(restartedAt: string | undefined): string {
  if (restartedAt === undefined) return "never";
  const time = Date.parse(restartedAt);
  return Number.isNaN(time) ? "unreadable" : new Date(time).toISOString();
}

/** The label selector of the deployment's pods; only matchLabels, which is what rollouts and kubectl create. */
export function podSelector(deployment: Deployment): string {
  const labels = Object.entries(deployment.spec.selector.matchLabels ?? {});
  if (labels.length === 0 || deployment.spec.selector.matchExpressions !== undefined) {
    throw new ToolError("unsupported", `${deployment.metadata.name} selects its pods with expressions; not supported`);
  }
  return labels.map(([key, value]) => `${key}=${value}`).join(",");
}

/** Refuses a restart the rate limits forbid, counting restarts from the annotation, so hand restarts count too. */
export function assertWithinRateLimits(
  target: Deployment,
  all: readonly Deployment[],
  now: Date,
  limits: RateLimits = RATE_LIMITS,
): void {
  const sinceMs = (deployment: Deployment) => {
    const restartedAt = restartedAtOf(deployment);
    if (restartedAt === undefined) return Number.POSITIVE_INFINITY;
    const time = Date.parse(restartedAt);
    // Anyone who may patch the deployment can write the annotation: an unreadable one must not lift the limits.
    return Number.isNaN(time) ? 0 : now.getTime() - time;
  };
  const lastRestartMs = sinceMs(target);
  if (lastRestartMs < limits.perDeploymentMs) {
    const waitMinutes = Math.ceil((limits.perDeploymentMs - lastRestartMs) / 60_000);
    const message = `${target.metadata.name} was restarted less than ${limits.perDeploymentMs / 60_000} minutes ago`;
    throw new ToolError("rate_limited", `${message}; it can be restarted again in ${waitMinutes} min`);
  }
  const restartsLastHour = all.filter((deployment) => sinceMs(deployment) < HOUR_MS).length;
  if (restartsLastHour >= limits.perHour) {
    const message = `${restartsLastHour} deployments were restarted in the last hour; the limit is ${limits.perHour}`;
    throw new ToolError("rate_limited", message);
  }
}

/**
 * What `kubectl rollout status` waits for: the current spec observed (at least the one the restart produced), and
 * every replica updated, ready and available. The API leaves out counts that are 0.
 */
export function rolledOut(deployment: Deployment, restartGeneration: number): boolean {
  const status = deployment.status ?? {};
  const wanted = deployment.spec.replicas ?? 1;
  const generation = Math.max(restartGeneration, deployment.metadata.generation ?? 0);
  const counts = [status.updatedReplicas, status.replicas, status.availableReplicas, status.readyReplicas];
  return (status.observedGeneration ?? 0) >= generation && counts.every((count) => (count ?? 0) === wanted);
}
