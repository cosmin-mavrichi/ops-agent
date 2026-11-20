import { afterEach, describe, expect, it } from "vitest";
import { statusError } from "../../../src/adapters/k8s.js";
import { toolsFor } from "../../../src/tools/index.js";
import { type K8sEvent, k8sEvents, k8sPods, type Pod, summarizeEvents, summarizePod } from "../../../src/tools/k8s.js";
import { k8sLogs, UNTRUSTED_NOTE } from "../../../src/tools/k8s-logs.js";
import { defineTool, type K8sClient, Level, ToolError } from "../../../src/types.js";
import { startHarness } from "../../harness.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const ENV_SECRET = "planted-env-secret-7781";

/** Real pod specs carry env and args; the fixture does too, so tests prove they never come out. */
function pod(name: string, status: Pod["status"], extra: Partial<Pod["metadata"]> = {}): Pod {
  return {
    metadata: { name, namespace: "app", creationTimestamp: ago(3_600), ...extra },
    spec: {
      nodeName: "node-1",
      containers: [
        {
          name: "app",
          resources: { limits: { memory: "256Mi" } },
          env: [{ name: "DB_PASSWORD", value: ENV_SECRET }],
          args: [`--password=${ENV_SECRET}`],
        } as never,
      ],
    },
    status,
  };
}

const crashLooping = pod(
  "worker-5d8f9c7b6-x2x9p",
  {
    phase: "Running",
    containerStatuses: [
      {
        name: "app",
        image: "registry.local/worker:1.4.2",
        ready: false,
        restartCount: 7,
        state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
        lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: ago(40) } },
      },
    ],
  },
  { labels: { "pod-template-hash": "5d8f9c7b6" }, ownerReferences: [{ kind: "ReplicaSet", name: "worker-5d8f9c7b6" }] },
);

const healthy = pod("api-0", {
  phase: "Running",
  containerStatuses: [{ name: "app", ready: true, restartCount: 0, state: { running: { startedAt: ago(600) } } }],
});

describe("summarizePod", () => {
  it("explains a crash loop: waiting reason, last termination, owner", () => {
    expect(summarizePod(crashLooping, NOW)).toMatchObject({
      name: "worker-5d8f9c7b6-x2x9p",
      owner: "Deployment/worker",
      phase: "Running",
      healthy: false,
      ready: "0/1",
      restarts: 7,
      containers: [
        {
          name: "app",
          state: "waiting",
          reason: "CrashLoopBackOff",
          last_termination: { reason: "OOMKilled", exit_code: 137, finished_ago_s: 40 },
          limits: { memory: "256Mi" },
        },
      ],
    });
  });

  it("never returns env or args from the spec", () => {
    const text = JSON.stringify(summarizePod(crashLooping, NOW));
    expect(text).not.toContain(ENV_SECRET);
    expect(text).not.toContain("DB_PASSWORD");
  });

  it("reports a failing init container ahead of the app container", () => {
    const stuck = pod("api-1", {
      phase: "Pending",
      initContainerStatuses: [
        { name: "migrate", ready: false, restartCount: 2, state: { terminated: { reason: "Error", exitCode: 1 } } },
      ],
      containerStatuses: [{ name: "app", ready: false, state: { waiting: { reason: "PodInitializing" } } }],
    });
    const summary = summarizePod(stuck, NOW);
    expect(summary.healthy).toBe(false);
    expect(summary.containers[0]).toMatchObject({ name: "migrate", init: true, state: "terminated", exit_code: 1 });
  });

  it("surfaces pod-level reasons such as eviction", () => {
    const evicted = pod("api-2", {
      phase: "Failed",
      reason: "Evicted",
      message: "The node was low on resource: memory.",
    });
    expect(summarizePod(evicted, NOW)).toMatchObject({ healthy: false, reason: "Evicted" });
  });

  it("does not call a crash-looping pod healthy in the moment it happens to be running", () => {
    const flapping = (lastExitAgo: number) =>
      pod("worker-1", {
        phase: "Running",
        containerStatuses: [
          {
            name: "app",
            ready: true,
            restartCount: 5,
            state: { running: { startedAt: ago(2) } },
            lastState: { terminated: { reason: "Error", exitCode: 3, finishedAt: ago(lastExitAgo) } },
          },
        ],
      });
    expect(summarizePod(flapping(5), NOW)).toMatchObject({ healthy: false, ready: "1/1" });
    expect(summarizePod(flapping(7_200), NOW)).toMatchObject({ healthy: true });
  });

  it("counts a running pod with all containers ready as healthy", () => {
    expect(summarizePod(healthy, NOW)).toMatchObject({ healthy: true, ready: "1/1", owner: null });
  });
});

describe("summarizeEvents", () => {
  const event = (reason: string, name: string, lastAgo: number, count = 1): K8sEvent => ({
    type: "Warning",
    reason,
    message: `${reason} on ${name}`,
    count,
    firstTimestamp: ago(lastAgo + 100),
    lastTimestamp: ago(lastAgo),
    involvedObject: { kind: "Pod", name, namespace: "app" },
  });

  it("groups repeats of the same reason on the same object", () => {
    const grouped = summarizeEvents([event("BackOff", "worker", 30, 4), event("BackOff", "worker", 10, 3)], NOW, 60);
    expect(grouped).toEqual([
      expect.objectContaining({ reason: "BackOff", object: "Pod/worker", count: 7, last_seen_ago_s: 10 }),
    ]);
  });

  it("drops events older than the window and sorts newest first", () => {
    const events = [event("Old", "a", 7_200), event("Unhealthy", "b", 300), event("BackOff", "c", 5)];
    expect(summarizeEvents(events, NOW, 60).map((e) => e.reason)).toEqual(["BackOff", "Unhealthy"]);
  });

  it("reads the newer series format", () => {
    const series: K8sEvent = {
      type: "Warning",
      reason: "BackOff",
      eventTime: ago(900),
      series: { count: 12, lastObservedTime: ago(20) },
      involvedObject: { kind: "Pod", name: "worker", namespace: "app" },
    };
    expect(summarizeEvents([series], NOW, 60)[0]).toMatchObject({ count: 12, last_seen_ago_s: 20 });
  });
});

/** Fake API that records requests and answers by path. */
function fakeK8s(responses: Record<string, unknown> = {}, namespaces = ["app", "jobs"]) {
  const calls: Array<{ path: string; query: Record<string, unknown> }> = [];
  const answer = (path: string, query: Record<string, unknown> = {}) => {
    calls.push({ path, query });
    const match = Object.keys(responses).find((suffix) => path.endsWith(suffix));
    if (match === undefined) return { items: [] };
    return responses[match];
  };
  const client: K8sClient = {
    namespaces,
    getJson: async <T>(path: string, _signal?: AbortSignal, query?: Record<string, unknown>) =>
      answer(path, query) as T,
    getText: async (path, _signal, query) => answer(path, query) as string,
  };
  return { client, calls };
}

let h: Awaited<ReturnType<typeof startHarness>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("namespace allowlist", () => {
  it("queries every allowed namespace when none is given", async () => {
    const k8s = fakeK8s();
    h = await startHarness({ tools: [k8sPods], k8s: k8s.client });
    await h.call("k8s_pods");
    expect(k8s.calls.map((c) => c.path)).toEqual(["/api/v1/namespaces/app/pods", "/api/v1/namespaces/jobs/pods"]);
  });

  it.each([
    ["k8s_pods", { namespace: "kube-system" }],
    ["k8s_events", { namespace: "kube-system" }],
    ["k8s_logs", { namespace: "kube-system", pod: "coredns-1" }],
  ])("%s refuses other namespaces without calling the API", async (tool, args) => {
    const k8s = fakeK8s();
    h = await startHarness({ tools: [k8sPods, k8sEvents, k8sLogs], k8s: k8s.client });
    const res = await h.call(tool, args);
    expect(res.json.error).toBe("forbidden_namespace");
    expect(k8s.calls).toEqual([]);
  });
});

describe("k8s_pods (unit)", () => {
  it("lists unhealthy pods first and never leaks env", async () => {
    const k8s = fakeK8s({ "/app/pods": { items: [healthy, crashLooping] } }, ["app"]);
    h = await startHarness({ tools: [k8sPods], k8s: k8s.client });
    const res = await h.call("k8s_pods");
    expect(res.json).toMatchObject({ total: 2, unhealthy: 1 });
    expect(res.json.pods.map((p: { name: string }) => p.name)).toEqual(["worker-5d8f9c7b6-x2x9p", "api-0"]);
    expect(res.text).not.toContain(ENV_SECRET);
  });

  it("can hide healthy pods", async () => {
    const k8s = fakeK8s({ "/app/pods": { items: [healthy, crashLooping] } }, ["app"]);
    h = await startHarness({ tools: [k8sPods], k8s: k8s.client });
    const res = await h.call("k8s_pods", { unhealthy_only: true });
    expect(res.json.pods).toHaveLength(1);
  });
});

describe("k8s_events (unit)", () => {
  it("asks the API for warnings only by default", async () => {
    const k8s = fakeK8s({}, ["app"]);
    h = await startHarness({ tools: [k8sEvents], k8s: k8s.client });
    await h.call("k8s_events");
    await h.call("k8s_events", { warnings_only: false });
    expect(k8s.calls.map((c) => c.query)).toEqual([{ fieldSelector: "type=Warning" }, {}]);
  });
});

describe("k8s_logs (unit)", () => {
  const LOG = [
    "2026-11-20T11:59:58Z starting worker",
    "2026-11-20T11:59:59Z API_KEY=sk_live_planted_4410",
    `2026-11-20T11:59:59Z ${"x".repeat(2_000)}`,
    "",
  ].join("\n");

  it("asks for the previous container's tail with a byte cap", async () => {
    const k8s = fakeK8s({ "/log": LOG }, ["app"]);
    h = await startHarness({ tools: [k8sLogs], k8s: k8s.client });
    await h.call("k8s_logs", { namespace: "app", pod: "worker-1", container: "app", previous: true, tail_lines: 50 });
    expect(k8s.calls[0]).toEqual({
      path: "/api/v1/namespaces/app/pods/worker-1/log",
      query: expect.objectContaining({ container: "app", previous: true, tailLines: 50, limitBytes: 65_536 }),
    });
  });

  it("redacts secrets, clips long lines and marks the output as untrusted", async () => {
    h = await startHarness({ tools: [k8sLogs], k8s: fakeK8s({ "/log": LOG }, ["app"]).client });
    const res = await h.call("k8s_logs", { namespace: "app", pod: "worker-1" });
    expect(res.json.line_count).toBe(3);
    expect(res.text).not.toContain("sk_live_planted_4410");
    expect(res.json.lines[2].length).toBeLessThan(600);
    expect(res.json.note).toBe(UNTRUSTED_NOTE);
  });

  it("explains logs lost to a container restart instead of returning them as a line", async () => {
    const lost = "unable to retrieve container logs for containerd://5d9a9cc140f7";
    h = await startHarness({ tools: [k8sLogs], k8s: fakeK8s({ "/log": lost }, ["app"]).client });
    const res = await h.call("k8s_logs", { namespace: "app", pod: "worker-1", previous: true });
    expect(res.json).toMatchObject({ error: "logs_unavailable" });
    expect(res.json.message).toContain("previous=false");
  });

  it.each(["../secrets", "worker/../../secrets", "Worker", "a b"])("rejects pod name %j", async (name) => {
    const k8s = fakeK8s({}, ["app"]);
    h = await startHarness({ tools: [k8sLogs], k8s: k8s.client });
    expect((await h.call("k8s_logs", { namespace: "app", pod: name })).isError).toBe(true);
    expect(k8s.calls).toEqual([]);
  });
});

describe("toolsFor", () => {
  const tool = (name: string, requires?: ("pg" | "k8s")[]) =>
    defineTool({ name, level: Level.Read, title: name, description: "t", input: {}, requires, run: async () => ({}) });

  it("exposes only tools whose adapters are configured", () => {
    const tools = [tool("pg_x", ["pg"]), tool("k8s_x", ["k8s"]), tool("both", ["pg", "k8s"]), tool("none")];
    expect(toolsFor(tools, ["pg"]).map((t) => t.name)).toEqual(["pg_x", "none"]);
    expect(toolsFor(tools, ["pg", "k8s"]).map((t) => t.name)).toEqual(["pg_x", "k8s_x", "both", "none"]);
  });
});

describe("statusError", () => {
  it.each([
    [400, "invalid_request"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("maps %i to ToolError %s", (status, code) => {
    const err = statusError(status, "/api/v1/x", JSON.stringify({ message: "nope" }));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe(code);
  });

  it("keeps other failures internal", () => {
    expect(statusError(500, "/api/v1/x", "boom")).not.toBeInstanceOf(ToolError);
  });
});
