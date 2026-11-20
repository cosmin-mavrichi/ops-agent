import { describe, expect, it } from "vitest";
import { type K8sEvent, k8sEvents, summarizeEvents } from "../../../src/tools/k8s/events.js";
import { useHarness } from "../../harness.js";
import { ago, fakeK8s, NOW } from "./fake-k8s.js";

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

const harness = useHarness();

describe("k8s_events (unit)", () => {
  it("asks the API for warnings only by default", async () => {
    const k8s = fakeK8s({}, ["app"]);
    const h = await harness({ tools: [k8sEvents], k8s: k8s.client });
    await h.call("k8s_events");
    await h.call("k8s_events", { warnings_only: false });
    expect(k8s.calls.map((c) => c.query)).toEqual([{ fieldSelector: "type=Warning" }, {}]);
  });
});
