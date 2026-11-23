import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPromClient } from "../../../src/adapters/prometheus.js";
import { promHttpHealth } from "../../../src/tools/prometheus/http-health.js";
import { type Harness, startHarness } from "../../harness.js";
import { fakeK8s } from "../../unit/k8s/fake-k8s.js";
import { historyOf, liveMetrics, OTEL, PROM_CLIENT, type Traffic } from "./http-traffic.js";
import { type MetricsTarget, type PromFixture, serveMetrics, startPrometheus } from "./prom-fixture.js";

const HOUR_S = 3600;
const startedAt = Date.now();

const api = `namespace="app",service="api"`;
const search = `namespace="app",service="search"`;
const steady = `namespace="app",service="steady"`;
// Scraped series get job="apps" from the scrape config; backfilled ones must carry it to be summed with them.
const backfilled = `job="apps",instance="history"`;

/** The day before: api fails 0.5% of requests, search answers in 50 ms, steady fails 3%. */
const USUAL: readonly Traffic[] = [
  { histogram: PROM_CLIENT, labels: `${api},${backfilled},status_code="200"`, perSecond: 199, seconds: 0.05 },
  { histogram: PROM_CLIENT, labels: `${api},${backfilled},status_code="500"`, perSecond: 1, seconds: 0.05 },
  { histogram: PROM_CLIENT, labels: `${steady},${backfilled},status_code="200"`, perSecond: 97, seconds: 0.05 },
  { histogram: PROM_CLIENT, labels: `${steady},${backfilled},status_code="500"`, perSecond: 3, seconds: 0.05 },
  {
    histogram: OTEL,
    labels: `${search},${backfilled},http_response_status_code="200"`,
    perSecond: 100,
    seconds: 0.05,
  },
];

/** Now, all under the limits (5%, 1000 ms): api fails 3%, search takes 400 ms, steady still fails 3%. */
const NOW: readonly Traffic[] = [
  { histogram: PROM_CLIENT, labels: `${api},status_code="200"`, perSecond: 485, seconds: 0.05 },
  { histogram: PROM_CLIENT, labels: `${api},status_code="500"`, perSecond: 15, seconds: 0.05 },
  { histogram: PROM_CLIENT, labels: `${steady},status_code="200"`, perSecond: 485, seconds: 0.05 },
  { histogram: PROM_CLIENT, labels: `${steady},status_code="500"`, perSecond: 15, seconds: 0.05 },
  { histogram: OTEL, labels: `${search},http_response_status_code="200"`, perSecond: 500, seconds: 0.4 },
];

let target: MetricsTarget;
let prometheus: PromFixture;
let h: Harness;

beforeAll(async () => {
  const now = Math.floor(startedAt / 1000);
  // Covers the usual window (the day before the last hour) and ends before the live scrapes begin.
  const history = historyOf(USUAL, now - 26 * HOUR_S, now - HOUR_S - 60);
  target = await serveMetrics(() => liveMetrics(NOW, startedAt));
  const scrape = `  - { job_name: apps, static_configs: [{ targets: ["${target.address}"] }] }`;
  prometheus = await startPrometheus(scrape, history);
  h = await startHarness({
    tools: [promHttpHealth],
    prom: createPromClient({ url: prometheus.url }),
    k8s: fakeK8s({}, ["app"]).client,
  });
}, 180_000);

afterAll(async () => {
  await h?.close();
  await prometheus?.stop();
  target?.close();
});

describe("prom_http_health against a day of history", () => {
  it("flags what is worse than usual though under the limits, and leaves the steady app alone", async () => {
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
    const find = (name: string) => res.json.apps.find((entry: { app: string }) => entry.app === name);
    expect(find("api").usual_error_pct).toBe(0.5);
    expect(find("api").problems.join("\n")).toMatch(/failed \(5xx\) in the last 5 minutes, usually 0\.5%/);
    expect(find("search").usual_p95_ms).toBeLessThan(100);
    expect(find("search").problems.join("\n")).toMatch(/^p95 latency \d+ ms in the last 5 minutes, usually \d+ ms/);
    expect(find("steady")).toMatchObject({ usual_error_pct: 3, problems: [] });
  }, 60_000);
});
