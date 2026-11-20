import { describe, expect, it } from "vitest";
import { k8sEvents } from "../../../src/tools/k8s/events.js";
import { k8sLogs } from "../../../src/tools/k8s/logs.js";
import { k8sPods } from "../../../src/tools/k8s/pods.js";
import { useHarness } from "../../harness.js";
import { fakeK8s } from "./fake-k8s.js";

const harness = useHarness();

describe("namespace allowlist", () => {
  it("queries every allowed namespace when none is given", async () => {
    const k8s = fakeK8s();
    const h = await harness({ tools: [k8sPods], k8s: k8s.client });
    await h.call("k8s_pods");
    expect(k8s.calls.map((c) => c.path)).toEqual(["/api/v1/namespaces/app/pods", "/api/v1/namespaces/jobs/pods"]);
  });

  it.each([
    ["k8s_pods", { namespace: "kube-system" }],
    ["k8s_events", { namespace: "kube-system" }],
    ["k8s_logs", { namespace: "kube-system", pod: "coredns-1" }],
  ])("%s refuses other namespaces without calling the API", async (tool, args) => {
    const k8s = fakeK8s();
    const h = await harness({ tools: [k8sPods, k8sEvents, k8sLogs], k8s: k8s.client });
    const res = await h.call(tool, args);
    expect(res.json.error).toBe("forbidden_namespace");
    expect(k8s.calls).toEqual([]);
  });
});
