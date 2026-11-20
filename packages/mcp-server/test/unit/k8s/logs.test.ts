import { describe, expect, it } from "vitest";
import { k8sLogs, UNTRUSTED_NOTE } from "../../../src/tools/k8s/logs.js";
import { useHarness } from "../../harness.js";
import { fakeK8s } from "./fake-k8s.js";

const harness = useHarness();

describe("k8s_logs (unit)", () => {
  const LOG = [
    "2026-11-20T11:59:58Z starting worker",
    "2026-11-20T11:59:59Z API_KEY=sk_live_planted_4410",
    `2026-11-20T11:59:59Z ${"x".repeat(2_000)}`,
    "",
  ].join("\n");

  it("asks for the previous container's tail with a byte cap", async () => {
    const k8s = fakeK8s({ "/log": LOG }, ["app"]);
    const h = await harness({ tools: [k8sLogs], k8s: k8s.client });
    await h.call("k8s_logs", { namespace: "app", pod: "worker-1", container: "app", previous: true, tail_lines: 50 });
    expect(k8s.calls[0]).toEqual({
      path: "/api/v1/namespaces/app/pods/worker-1/log",
      query: expect.objectContaining({ container: "app", previous: true, tailLines: 50, limitBytes: 65_536 }),
    });
  });

  it("redacts secrets, clips long lines and marks the output as untrusted", async () => {
    const h = await harness({ tools: [k8sLogs], k8s: fakeK8s({ "/log": LOG }, ["app"]).client });
    const res = await h.call("k8s_logs", { namespace: "app", pod: "worker-1" });
    expect(res.json.line_count).toBe(3);
    expect(res.text).not.toContain("sk_live_planted_4410");
    expect(res.json.lines[2].length).toBeLessThan(600);
    expect(res.json.note).toBe(UNTRUSTED_NOTE);
  });

  const LOST = "unable to retrieve container logs for containerd://5d9a9cc140f7";

  it("falls back to the current container when kubelet already deleted the previous one", async () => {
    const k8s = fakeK8s({ "/log": (query: { previous: boolean }) => (query.previous ? LOST : LOG) }, ["app"]);
    const h = await harness({ tools: [k8sLogs], k8s: k8s.client });
    const res = await h.call("k8s_logs", { namespace: "app", pod: "worker-1", previous: true });
    expect(res.json).toMatchObject({ previous: true, read_from: "current", line_count: 3 });
    expect(res.json.fallback).toContain("already deleted");
    expect(k8s.calls.map((call) => call.query.previous)).toEqual([true, false]);
  });

  it("explains logs that are gone from both containers instead of returning them as a line", async () => {
    const h = await harness({ tools: [k8sLogs], k8s: fakeK8s({ "/log": LOST }, ["app"]).client });
    const res = await h.call("k8s_logs", { namespace: "app", pod: "worker-1", previous: true });
    expect(res.json).toMatchObject({ error: "logs_unavailable" });
    expect(res.json.message).toContain("k8s_pods");
  });

  it("reports the original problem when the current container can't be read either", async () => {
    const waiting = (query: { previous: boolean }) => {
      if (query.previous) return LOST;
      throw new Error('container "app" in pod "worker-1" is waiting to start');
    };
    const h = await harness({ tools: [k8sLogs], k8s: fakeK8s({ "/log": waiting }, ["app"]).client });
    const res = await h.call("k8s_logs", { namespace: "app", pod: "worker-1", previous: true });
    expect(res.json).toMatchObject({ error: "logs_unavailable" });
  });

  it("does not fall back when the current container's logs were asked for", async () => {
    const k8s = fakeK8s({ "/log": LOST }, ["app"]);
    const h = await harness({ tools: [k8sLogs], k8s: k8s.client });
    await h.call("k8s_logs", { namespace: "app", pod: "worker-1" });
    expect(k8s.calls).toHaveLength(1);
  });

  it.each(["../secrets", "worker/../../secrets", "Worker", "a b"])("rejects pod name %j", async (name) => {
    const k8s = fakeK8s({}, ["app"]);
    const h = await harness({ tools: [k8sLogs], k8s: k8s.client });
    expect((await h.call("k8s_logs", { namespace: "app", pod: name })).isError).toBe(true);
    expect(k8s.calls).toEqual([]);
  });
});
