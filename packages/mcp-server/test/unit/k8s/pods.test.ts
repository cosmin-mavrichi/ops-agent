import { describe, expect, it } from "vitest";
import { k8sPods, type Pod, summarizePod } from "../../../src/tools/k8s/pods.js";
import { useHarness } from "../../harness.js";
import { ago, fakeK8s, NOW } from "./fake-k8s.js";

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

  it("reports a pod being deleted as Terminating, not a healthy running pod", () => {
    // After a scale-down to 0 the old pod still reports phase Running, ready, until its containers exit.
    const shuttingDown = { ...healthy, metadata: { ...healthy.metadata, deletionTimestamp: ago(12) } };
    expect(summarizePod(shuttingDown, NOW)).toMatchObject({
      phase: "Terminating",
      healthy: false,
      deleting_since_s: 12,
    });
    expect(summarizePod(healthy, NOW)).not.toHaveProperty("deleting_since_s");
  });
});

const harness = useHarness();

describe("k8s_pods (unit)", () => {
  it("lists unhealthy pods first and never leaks env", async () => {
    const k8s = fakeK8s({ "/app/pods": { items: [healthy, crashLooping] } }, ["app"]);
    const h = await harness({ tools: [k8sPods], k8s: k8s.client });
    const res = await h.call("k8s_pods");
    expect(res.json).toMatchObject({ total: 2, unhealthy: 1 });
    expect(res.json.pods.map((p: { name: string }) => p.name)).toEqual(["worker-5d8f9c7b6-x2x9p", "api-0"]);
    expect(res.text).not.toContain(ENV_SECRET);
  });

  it("can hide healthy pods", async () => {
    const k8s = fakeK8s({ "/app/pods": { items: [healthy, crashLooping] } }, ["app"]);
    const h = await harness({ tools: [k8sPods], k8s: k8s.client });
    const res = await h.call("k8s_pods", { unhealthy_only: true });
    expect(res.json.pods).toHaveLength(1);
  });
});
