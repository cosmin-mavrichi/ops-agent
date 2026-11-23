import { describe, expect, it } from "vitest";
import { promHttpHealth, statusRegex, summarizeApps } from "../../../src/tools/prometheus/http-health.js";
import type { PromClient, PromSample } from "../../../src/types.js";
import { DEFAULT_HTTP_CHECKS, useHarness } from "../../harness.js";
import { fakeK8s } from "../k8s/fake-k8s.js";

const harness = useHarness();
const PLANTED = "planted-route-token-2290";

const app = (service: string, value: number, extra: Record<string, string> = {}): PromSample => ({
  labels: { namespace: "app", service, ...extra },
  value,
});

type Kind = "requests" | "errors" | "p95";
type Answers = Readonly<Partial<Record<Kind, readonly PromSample[]>>>;

const kindOf = (promql: string): Kind => {
  if (promql.startsWith("histogram_quantile")) return "p95";
  return promql.includes("status_code=~") ? "errors" : "requests";
};

/** Answers OpenTelemetry-named queries with `otel` and prom-client-named ones with `promClient`. */
function fakeHttpProm(otel: Answers, promClient: Answers = {}) {
  const queries: string[] = [];
  const client: PromClient = {
    query: async (promql) => {
      queries.push(promql);
      const answers = promql.includes("http_server_request_duration_seconds") ? otel : promClient;
      return [...(answers[kindOf(promql)] ?? [])];
    },
  };
  return { client, queries };
}

describe("summarizeApps", () => {
  const apps = summarizeApps(
    {
      requests: [app("api", 20), app("search", 4), app("admin", 0.05)],
      errors: [app("api", 2), app("admin", 0.05)],
      p95: [app("api", 0.12), app("search", 2.5), app("admin", Number.NaN)],
    },
    DEFAULT_HTTP_CHECKS,
  );
  const find = (name: string) => apps.find((entry) => entry.app === name);

  it("flags an app whose error share passes the limit", () => {
    expect(find("api")).toMatchObject({ requests_per_s: 20, error_pct: 10, p95_ms: 120 });
    expect(find("api")?.problems).toEqual(["10% of requests failed (5xx) in the last 5 minutes, at 20 requests/s"]);
  });

  it("flags a slow app", () => {
    expect(find("search")).toMatchObject({
      error_pct: 0,
      problems: ["p95 latency 2500 ms in the last 5 minutes (limit 1000 ms)"],
    });
  });

  it("does not judge an app with almost no traffic", () => {
    expect(find("admin")).toMatchObject({ error_pct: 100, p95_ms: null, problems: [] });
  });

  it("falls back to the job label when there is no service label", () => {
    const [only] = summarizeApps(
      { requests: [{ labels: { namespace: "app", job: "api" }, value: 1 }], errors: [], p95: [] },
      DEFAULT_HTTP_CHECKS,
    );
    expect(only).toMatchObject({ app: "api", p95_ms: null, problems: [] });
  });
});

describe("statusRegex", () => {
  it("turns classes into a PromQL regex", () => {
    expect(statusRegex(["5xx", "429"])).toBe("5..|429");
  });
});

describe("prom_http_health (unit)", () => {
  it("reads both namings, lists apps with problems first and never returns other labels", async () => {
    const prom = fakeHttpProm(
      { requests: [app("search", 30)], p95: [app("search", 0.05)] },
      { requests: [app("api", 10, { route: `/reset/${PLANTED}` })], errors: [app("api", 5)] },
    );
    const h = await harness({ tools: [promHttpHealth], prom: prom.client, k8s: fakeK8s().client });
    const res = await h.call("prom_http_health");
    expect(res.isError, res.text).toBe(false);
    expect(res.json.apps.map((entry: { app: string }) => entry.app)).toEqual(["api", "search"]);
    expect(res.json.apps[0].error_pct).toBe(50);
    expect(res.text).not.toContain(PLANTED);
  });

  it("counts the statuses the operator chose as errors", async () => {
    const prom = fakeHttpProm({});
    const httpChecks = { ...DEFAULT_HTTP_CHECKS, errorStatus: ["5xx", "429"] };
    const h = await harness({ tools: [promHttpHealth], prom: prom.client, k8s: fakeK8s().client, httpChecks });
    await h.call("prom_http_health");
    const errorQueries = prom.queries.filter((promql) => kindOf(promql) === "errors");
    expect(errorQueries).toHaveLength(2);
    expect(errorQueries.every((promql) => promql.includes('=~"5..|429"'))).toBe(true);
  });

  it("explains which metrics it reads when an app exposes none", async () => {
    const h = await harness({ tools: [promHttpHealth], prom: fakeHttpProm({}).client, k8s: fakeK8s().client });
    const res = await h.call("prom_http_health");
    expect(res.json).toMatchObject({ total: 0, apps: [] });
    expect(res.json.note).toContain("http_server_request_duration_seconds");
  });
});
