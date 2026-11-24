import { describe, expect, it, vi } from "vitest";
import type { K8sEvent } from "../../../src/tools/k8s/events.js";
import type { Pod } from "../../../src/tools/k8s/pods.js";
import { opsTriage } from "../../../src/tools/triage.js";
import type { RedisClient, SqlClient, ToolContext } from "../../../src/types.js";
import { useHarness } from "../../harness.js";
import { fakeK8s } from "../k8s/fake-k8s.js";
import { FULL_VALKEY_INFO, fakeRedis } from "../redis/fake-redis.js";

const harness = useHarness();

// Tools compare timestamps with the real clock, so fixtures are relative to it.
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const unixSecondsAgo = (seconds: number) => Math.round(Date.now() / 1000) - seconds;

/** No rows for anything: no lock waits, and no pg-boss schema. */
const emptyPg: SqlClient = { query: async () => [] };

const crashLooping = (name: string): Pod => ({
  metadata: { name, namespace: "app", creationTimestamp: secondsAgo(600) },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "worker",
        ready: false,
        restartCount: 5,
        state: { waiting: { reason: "CrashLoopBackOff" } },
        lastState: { terminated: { reason: "Error", exitCode: 1, finishedAt: secondsAgo(20) } },
      },
    ],
  },
});

const backOff: K8sEvent = {
  type: "Warning",
  reason: "BackOff",
  message: "Back-off restarting failed container worker",
  count: 4,
  lastTimestamp: secondsAgo(30),
  involvedObject: { kind: "Pod", name: "worker-1", namespace: "app" },
};

const slowValkey = () =>
  fakeRedis({
    INFO: FULL_VALKEY_INFO,
    "CLIENT LIST": "",
    "SLOWLOG GET": [[1, unixSecondsAgo(5), 70_000, ["KEYS", "order:*"], "10.42.0.7:40000", "reports"]],
    "SLOWLOG LEN": 1,
  }).client;

const brokenK8s = () =>
  fakeK8s({ "/pods": { items: [crashLooping("worker-1")] }, "/events": { items: [backOff] } }, ["app"]);

describe("ops_triage (unit)", () => {
  it("groups problems by the tool that found them and lists the clean and unavailable checks", async () => {
    const h = await harness({ tools: [opsTriage], pg: emptyPg, k8s: brokenK8s().client, redis: slowValkey() });
    const res = await h.call("ops_triage");

    expect(res.json.problems.k8s_pods).toEqual([
      "1 of 1 pods unhealthy",
      "app/worker-1 (no owner): Running, ready 0/1, 5 restarts; worker waiting: CrashLoopBackOff, last exited 1 (Error)",
    ]);
    expect(res.json.problems.k8s_events[0]).toMatch(/^BackOff on Pod\/worker-1 in app, 4 times, last 30 seconds ago/);
    expect(res.json.problems.redis_slowlog[0]).toContain("KEYS from reports");
    expect(res.json.problems.redis_health.length).toBeGreaterThan(0);
    expect(res.json.clean).toEqual(
      expect.arrayContaining(["k8s_changes", "k8s_certificates", "k8s_pg_backups", "pg_blocking"]),
    );
    expect(res.json.not_installed.pg_job_queues).toMatch(/pg-boss/);
    expect(res.json.unavailable).toEqual({});
  });

  it("runs only the checks whose adapters are configured", async () => {
    const h = await harness({ tools: [opsTriage], pg: emptyPg });
    const res = await h.call("ops_triage");
    const checked = [
      ...Object.keys(res.json.problems),
      ...res.json.clean,
      ...Object.keys(res.json.unavailable),
      ...Object.keys(res.json.not_installed),
    ];
    expect(checked.toSorted()).toEqual(["pg_blocking", "pg_job_queues"]);
  });

  it("hides the text of an unexpected error, which can carry hosts and passwords", async () => {
    const unreachable: RedisClient = {
      send: async () => {
        throw new Error("connect ECONNREFUSED redis://:hunter2-planted@10.0.0.5:6379");
      },
    };
    const h = await harness({ tools: [opsTriage], pg: emptyPg, redis: unreachable });
    const res = await h.call("ops_triage");
    expect(res.json.unavailable.redis_health).toBe("failed; run redis_health for details");
    expect(res.text).not.toContain("hunter2-planted");
    expect(res.text).not.toContain("10.0.0.5");
  });

  it("caps each check's problems and says how many more there are", async () => {
    const pods = Array.from({ length: 12 }, (_, i) => crashLooping(`worker-${i}`));
    const k8s = fakeK8s({ "/pods": { items: pods } }, ["app"]);
    const h = await harness({ tools: [opsTriage], pg: emptyPg, k8s: k8s.client });
    const res = await h.call("ops_triage");
    expect(res.json.problems.k8s_pods).toHaveLength(11);
    expect(res.json.problems.k8s_pods.at(-1)).toBe("…and 3 more: see k8s_pods");
  });

  it("reports a check that does not finish in time as unavailable instead of failing the whole triage", async () => {
    vi.useFakeTimers();
    try {
      const hanging: SqlClient = { query: () => new Promise(() => {}) };
      const ctx = { adapters: ["pg"], pg: hanging, signal: new AbortController().signal, log: () => {} };
      const result = opsTriage.run({}, ctx as unknown as ToolContext);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await result).unavailable).toEqual({
        pg_blocking: expect.stringMatching(/^did not finish within \d+ms$/),
        pg_job_queues: expect.stringMatching(/^did not finish within \d+ms$/),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
