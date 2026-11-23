import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPromClient } from "../../../src/adapters/prometheus.js";
import { promHttpHealth } from "../../../src/tools/prometheus/http-health.js";
import { type Harness, startHarness } from "../../harness.js";
import { fakeK8s } from "../../unit/k8s/fake-k8s.js";
import { liveMetrics, OTEL, PROM_CLIENT, type Traffic } from "./http-traffic.js";
import { type MetricsTarget, type PromFixture, serveMetrics, startPrometheus } from "./prom-fixture.js";

const PLANTED = "planted-route-token-6614";
const startedAt = Date.now();

const api = `namespace="app",service="api",route="/reset/${PLANTED}"`;
const search = `namespace="app",service="search"`;
const hidden = `namespace="kube-system",service="hidden",status_code="500"`;

/**
 * api (prom-client) fails 20% of its requests, search (OpenTelemetry) is slow, kube-system is not allowed.
 * Busy apps: a fresh Prometheus divides the few seconds it has seen by the whole 5-minute window, so the rates
 * read low until five minutes have passed, and must still clear the tool's minimum traffic.
 */
const TRAFFIC: readonly Traffic[] = [
  { histogram: PROM_CLIENT, labels: `${api},status_code="200"`, perSecond: 400, seconds: 0.05 },
  { histogram: PROM_CLIENT, labels: `${api},status_code="500"`, perSecond: 100, seconds: 0.05 },
  { histogram: OTEL, labels: `${search},http_response_status_code="200"`, perSecond: 250, seconds: 2 },
  { histogram: PROM_CLIENT, labels: hidden, perSecond: 250, seconds: 0.05 },
];

let target: MetricsTarget;
let prometheus: PromFixture;
let h: Harness;

beforeAll(async () => {
  target = await serveMetrics(() => liveMetrics(TRAFFIC, startedAt));
  prometheus = await startPrometheus(`  - { job_name: apps, static_configs: [{ targets: ["${target.address}"] }] }`);
  h = await startHarness({
    tools: [promHttpHealth],
    prom: createPromClient({ url: prometheus.url }),
    k8s: fakeK8s({}, ["app"]).client,
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
  await prometheus?.stop();
  target?.close();
});

describe("prom_http_health against Prometheus", () => {
  it("finds the failing app and the slow one, from real queries", async () => {
    // rate() needs a few scrapes before it has a value, and a few more before both apps clear the minimum traffic.
    await vi.waitFor(
      async () => {
        const res = await h.call("prom_http_health");
        expect(res.isError, res.text).toBe(false);
        const withProblems = res.json.apps.filter((entry: { problems: string[] }) => entry.problems.length > 0);
        expect(withProblems).toHaveLength(2);
      },
      { timeout: 30_000, interval: 1_000 },
    );

    const res = await h.call("prom_http_health");
    const api = res.json.apps.find((entry: { app: string }) => entry.app === "api");
    const search = res.json.apps.find((entry: { app: string }) => entry.app === "search");
    expect(api.error_pct).toBeGreaterThan(15);
    expect(api.error_pct).toBeLessThan(25);
    expect(api.problems.join("\n")).toMatch(/% of requests failed \(5xx\)/);
    expect(search.p95_ms).toBeGreaterThan(1000);
    expect(search.problems.join("\n")).toMatch(/^p95 latency \d+ ms/);
  }, 60_000);

  it("never returns other namespaces or other labels", async () => {
    const res = await h.call("prom_http_health");
    expect(res.text).not.toContain("kube-system");
    expect(res.text).not.toContain("/reset/");
    expect(res.text).not.toContain(PLANTED);
  });
});
