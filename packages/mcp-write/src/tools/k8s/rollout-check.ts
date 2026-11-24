import { setTimeout as sleep } from "node:timers/promises";
import { type Pod, summarizePod } from "@ops-agent/mcp-server/shared";
import { deploymentPath } from "../../adapters/k8s-write.js";
import type { WriteContext } from "../../types.js";
import { type Deployment, rolledOut, summarizeDeployment } from "./deployment.js";

export interface RolloutTiming {
  /** "rolled out": every new pod ready within this. */
  readonly rolledOutWithinMs: number;
  /** "healthy": then none of them restarted or went unready for this long. */
  readonly healthyForMs: number;
  readonly pollMs: number;
}

export const ROLLOUT_TIMING: RolloutTiming = { rolledOutWithinMs: 120_000, healthyForMs: 60_000, pollMs: 2_000 };

/** What the restart achieved; the agent reports it, and only "healthy" counts as fixed. */
export type RolloutOutcome =
  | ({ readonly status: "healthy" } & PodsShown)
  | ({ readonly status: "rolled_out_unhealthy" } & PodsShown)
  | { readonly status: "not_rolled_out"; readonly deployment: ReturnType<typeof summarizeDeployment> }
  | { readonly status: "unknown"; readonly why: string };

export type PodSummary = ReturnType<typeof summarizePod>;

const MAX_PODS_RETURNED = 10;

/** The unhealthy pods first, then the rest, up to a cap: a big deployment would otherwise fill the output. */
interface PodsShown {
  readonly pod_count: number;
  readonly pods: readonly PodSummary[];
}

function podsShown(pods: readonly PodSummary[]): PodsShown {
  const unhealthyBeforeHealthy = (a: PodSummary, b: PodSummary) => Number(a.healthy) - Number(b.healthy);
  const unhealthyFirst = [...pods].sort(unhealthyBeforeHealthy);
  return { pod_count: pods.length, pods: unhealthyFirst.slice(0, MAX_PODS_RETURNED) };
}

export interface RolloutTarget {
  readonly namespace: string;
  readonly name: string;
  /** The generation the restart patch produced. */
  readonly generation: number;
  readonly selector: string;
}

export async function checkRollout(ctx: WriteContext, target: RolloutTarget): Promise<RolloutOutcome> {
  const path = deploymentPath(target.namespace, target.name);
  const readDeployment = () => ctx.k8s.getJson<Deployment>(path, ctx.signal);
  const isRolledOut = (deployment: Deployment) => rolledOut(deployment, target.generation);
  const rollout = await pollUntil(ctx, ctx.rollout.rolledOutWithinMs, readDeployment, isRolledOut);
  if (!rollout.done) return { status: "not_rolled_out", deployment: summarizeDeployment(rollout.last) };

  const readPods = () => listPods(ctx, target.namespace, target.selector);
  const anyUnhealthy = (pods: readonly PodSummary[]) => pods.some((pod) => !pod.healthy);
  const watched = await pollUntil(ctx, ctx.rollout.healthyForMs, readPods, anyUnhealthy);
  const status = watched.done ? "rolled_out_unhealthy" : "healthy";
  return { status, ...podsShown(watched.last) };
}

/** The deployment's pods that are not on their way out (old pods may still be terminating). */
export async function listPods(ctx: WriteContext, namespace: string, selector: string): Promise<readonly PodSummary[]> {
  const path = `/api/v1/namespaces/${namespace}/pods`;
  const list = await ctx.k8s.getJson<{ items: Pod[] }>(path, ctx.signal, { labelSelector: selector });
  const now = ctx.now();
  return list.items.filter((pod) => pod.metadata.deletionTimestamp === undefined).map((pod) => summarizePod(pod, now));
}

interface Polled<T> {
  readonly last: T;
  /** Whether `isDone` accepted `last` before the time ran out. */
  readonly done: boolean;
}

/** Reads every pollMs until `isDone` accepts what was read or `withinMs` has passed; returns the last read. */
async function pollUntil<T>(
  ctx: WriteContext,
  withinMs: number,
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
): Promise<Polled<T>> {
  const deadline = ctx.now().getTime() + withinMs;
  for (;;) {
    const last = await read();
    if (isDone(last)) return { last, done: true };
    if (ctx.now().getTime() >= deadline) return { last, done: false };
    await sleep(ctx.rollout.pollMs, undefined, { signal: ctx.signal });
  }
}
