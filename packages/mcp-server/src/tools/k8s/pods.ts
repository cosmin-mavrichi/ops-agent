import { z } from "zod";
import { defineTool, Level } from "../../types.js";
import { allowedNamespaces, clip, k8sLabel, nsPath, secondsSince } from "./shared.js";

// Only the fields the tools read. Pod specs also hold env, command and args, which can carry
// secrets; they are deliberately absent here so no code path can return them.
interface ContainerState {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; message?: string; exitCode?: number; finishedAt?: string };
}
interface ContainerStatus {
  name: string;
  image?: string;
  ready?: boolean;
  restartCount?: number;
  state?: ContainerState;
  lastState?: ContainerState;
}
interface ContainerSpec {
  name: string;
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
}
export interface Pod {
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<{ kind: string; name: string }>;
  };
  spec?: { nodeName?: string; containers?: ContainerSpec[]; initContainers?: ContainerSpec[] };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

const RECENT_RESTART_S = 600;
const MAX_PODS = 50;

/** A ReplicaSet named <deployment>-<pod-template-hash> is reported as its Deployment. */
function ownerOf(pod: Pod): string | null {
  const owner = pod.metadata.ownerReferences?.[0];
  if (!owner) return null;
  const hash = pod.metadata.labels?.["pod-template-hash"];
  if (owner.kind === "ReplicaSet" && hash && owner.name.endsWith(`-${hash}`)) {
    return `Deployment/${owner.name.slice(0, -(hash.length + 1))}`;
  }
  return `${owner.kind}/${owner.name}`;
}

function describeState(state: ContainerState | undefined, now: Date) {
  if (state?.running) return { state: "running", since_s: secondsSince(state.running.startedAt, now) };
  if (state?.waiting) return { state: "waiting", reason: state.waiting.reason, message: clip(state.waiting.message) };
  if (state?.terminated) {
    return {
      state: "terminated",
      reason: state.terminated.reason,
      exit_code: state.terminated.exitCode,
      message: clip(state.terminated.message),
      finished_ago_s: secondsSince(state.terminated.finishedAt, now),
    };
  }
  return { state: "unknown" };
}

type ContainerKind = "init" | "app";

function specsByName(pod: Pod): ReadonlyMap<string, ContainerSpec> {
  const specs = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])];
  return new Map(specs.map((spec) => [spec.name, spec]));
}

function summarizeContainer(status: ContainerStatus, spec: ContainerSpec | undefined, kind: ContainerKind, now: Date) {
  const last = status.lastState?.terminated;
  return {
    name: status.name,
    ...(kind === "init" ? { init: true } : {}),
    image: status.image,
    ready: status.ready ?? false,
    restarts: status.restartCount ?? 0,
    ...describeState(status.state, now),
    last_termination: last
      ? { reason: last.reason, exit_code: last.exitCode, finished_ago_s: secondsSince(last.finishedAt, now) }
      : null,
    limits: spec?.resources?.limits ?? null,
  };
}

export function summarizePod(pod: Pod, now: Date) {
  const initStatuses = pod.status?.initContainerStatuses ?? [];
  const appStatuses = pod.status?.containerStatuses ?? [];
  const specs = specsByName(pod);
  const summarize = (status: ContainerStatus, kind: ContainerKind) =>
    summarizeContainer(status, specs.get(status.name), kind, now);

  const containers = [
    ...initStatuses.map((status) => summarize(status, "init")),
    ...appStatuses.map((status) => summarize(status, "app")),
  ];

  const phase = pod.status?.phase ?? "Unknown";
  const readyCount = appStatuses.filter((status) => status.ready).length;
  const allReady = appStatuses.length > 0 && readyCount === appStatuses.length;
  // Between crashes a looping container is briefly running and (without a readiness probe) ready.
  const restartedRecently = containers.some((container) => {
    const finishedAgo = container.last_termination?.finished_ago_s;
    return finishedAgo != null && finishedAgo < RECENT_RESTART_S;
  });
  const healthy = phase === "Succeeded" || (phase === "Running" && allReady && !restartedRecently);

  return {
    namespace: pod.metadata.namespace,
    name: pod.metadata.name,
    owner: ownerOf(pod),
    phase,
    healthy,
    ready: `${readyCount}/${appStatuses.length}`,
    restarts: containers.reduce((sum, container) => sum + container.restarts, 0),
    age_s: secondsSince(pod.metadata.creationTimestamp, now),
    node: pod.spec?.nodeName ?? null,
    ...(pod.status?.reason ? { reason: pod.status.reason, message: clip(pod.status.message) } : {}),
    containers,
  };
}

type PodSummary = ReturnType<typeof summarizePod>;

const unhealthyFirstThenMostRestarts = (a: PodSummary, b: PodSummary) =>
  Number(a.healthy) - Number(b.healthy) || b.restarts - a.restarts;

export const k8sPods = defineTool({
  name: "k8s_pods",
  level: Level.Read,
  requires: ["k8s"],
  title: "Kubernetes: pod status",
  description:
    "Pods in the allowed namespaces, unhealthy first. A container that died in the last 10 minutes counts as " +
    "unhealthy even if it is running again. For each container: state (running, or waiting/terminated with a " +
    "reason such as CrashLoopBackOff, ImagePullBackOff, OOMKilled, Error, and the exit code), restart count, the " +
    "last termination, and resource limits. Owners are resolved to their Deployment. Use first when a service is " +
    "down, restarting or slow; then k8s_events for why, and k8s_logs for what the container said. Environment " +
    "variables and commands are never returned.",
  input: {
    namespace: k8sLabel.optional(),
    unhealthy_only: z.boolean().default(false),
  },
  timeoutMs: 8_000,

  async run({ namespace, unhealthy_only }, { k8s, signal }) {
    const now = new Date();
    const listPods = (ns: string) => k8s.getJson<{ items: Pod[] }>(`${nsPath(ns)}/pods`, signal);
    const lists = await Promise.all(allowedNamespaces(k8s, namespace).map(listPods));

    const pods = lists
      .flatMap((list) => list.items)
      .map((pod) => summarizePod(pod, now))
      .filter((pod) => !unhealthy_only || !pod.healthy)
      .toSorted(unhealthyFirstThenMostRestarts);

    return {
      total: pods.length,
      unhealthy: pods.filter((p) => !p.healthy).length,
      pods: pods.slice(0, MAX_PODS),
    };
  },
});
