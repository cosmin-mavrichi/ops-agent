import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPromClient } from "../../../src/adapters/prometheus.js";
import { promVolumeUsage } from "../../../src/tools/prometheus/volume-usage.js";
import { type Harness, startHarness } from "../../harness.js";
import { fakeK8s } from "../../unit/k8s/fake-k8s.js";
import { type MetricsTarget, type PromFixture, serveMetrics, startPrometheus } from "./prom-fixture.js";

const GIB = 1024 ** 3;
const PLANTED = "planted-scrape-label-7310";
const GROWTH_PER_S = 100 * 1024 ** 2;
const startedAt = Date.now();

/** What the kubelet would expose: a full database volume, a filling one, and one outside the allowlist. */
function kubeletMetrics(): string {
  const secondsRunning = (Date.now() - startedAt) / 1000;
  const uploadsUsed = 40 * GIB + GROWTH_PER_S * secondsRunning;
  const volumes = [
    { namespace: "app", pvc: "db-data", capacity: 10 * GIB, used: 9.6 * GIB },
    { namespace: "app", pvc: "uploads", capacity: 100 * GIB, used: uploadsUsed },
    { namespace: "kube-system", pvc: "hidden", capacity: GIB, used: GIB },
  ];
  return volumes
    .flatMap(({ namespace, pvc, capacity, used }) => {
      const labels = `namespace="${namespace}",persistentvolumeclaim="${pvc}",node_token="${PLANTED}"`;
      return [
        `kubelet_volume_stats_capacity_bytes{${labels}} ${capacity}`,
        `kubelet_volume_stats_used_bytes{${labels}} ${used}`,
        `kubelet_volume_stats_inodes{${labels}} 655360`,
        `kubelet_volume_stats_inodes_used{${labels}} 1200`,
      ];
    })
    .join("\n")
    .concat("\n");
}

let kubelet: MetricsTarget;
let prometheus: PromFixture;
let h: Harness;

beforeAll(async () => {
  kubelet = await serveMetrics(kubeletMetrics);
  prometheus = await startPrometheus(
    `  - { job_name: kubelet, static_configs: [{ targets: ["${kubelet.address}"] }] }`,
  );
  h = await startHarness({
    tools: [promVolumeUsage],
    prom: createPromClient({ url: prometheus.url }),
    k8s: fakeK8s({}, ["app"]).client,
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
  await prometheus?.stop();
  kubelet?.close();
});

describe("prom_volume_usage against Prometheus", () => {
  it("reports the full volume and the filling one, from real queries", async () => {
    // deriv() needs a few scrapes before it has a rate.
    await vi.waitFor(
      async () => {
        const res = await h.call("prom_volume_usage");
        expect(res.isError, res.text).toBe(false);
        const uploads = res.json.volumes.find((volume: { pvc: string }) => volume.pvc === "uploads");
        expect(uploads?.growth_bytes_per_hour).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 1_000 },
    );

    const res = await h.call("prom_volume_usage");
    const [first, second] = res.json.volumes;
    expect(first).toMatchObject({ pvc: "db-data", used_pct: 96, problems: ["96% full (9.6 GiB of 10 GiB)"] });
    expect(second.pvc).toBe("uploads");
    expect(second.problems.join("\n")).toMatch(/growing .*\/hour: full in about \d/);
  }, 60_000);

  it("never returns other namespaces or other labels", async () => {
    const res = await h.call("prom_volume_usage");
    expect(res.json.total).toBe(2);
    expect(res.text).not.toContain("kube-system");
    expect(res.text).not.toContain(PLANTED);
  });
});
