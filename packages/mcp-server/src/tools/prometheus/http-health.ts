import { z } from "zod";
import { defineTool, type HttpChecks, Level, type PromClient, type PromSample } from "../../types.js";
import { allowedNamespaces, k8sLabel } from "../k8s/shared.js";
import { namespaceMatcher } from "./volume-usage.js";

const NOW = "[5m]";
/** The day before the last hour, so an incident that started within the hour is not counted as usual. */
const USUAL = "[1d] offset 1h";
/** Below this (30 requests in 5 minutes) an error share or a p95 rests on a handful of requests. */
const MIN_REQUESTS_PER_S = 0.1;
// Worse than usual though under the operator's limits: a multiple of the usual value, and above a floor so
// that 0.01% → 0.05% errors or 20 → 50 ms is not an incident.
const UNUSUAL_ERRORS = { factor: 3, minPct: 1 } as const;
const UNUSUAL_P95 = { factor: 2, minMs: 300 } as const;

/** The two common namings: OpenTelemetry's semantic conventions, and Node's prom-client (express-prom-bundle). */
const NAMINGS = [
  { histogram: "http_server_request_duration_seconds", status: "http_response_status_code" },
  { histogram: "http_request_duration_seconds", status: "status_code" },
] as const;
type Naming = (typeof NAMINGS)[number];

// The only labels kept: scraped labels can carry anything, and routes or paths can embed ids and tokens.
const BY = "namespace, service, job";

const NO_DATA =
  "No HTTP request metrics for these namespaces. This tool reads the request duration histogram " +
  "http_server_request_duration_seconds (OpenTelemetry) or http_request_duration_seconds (prom-client); " +
  "apps that expose neither, or that Prometheus does not scrape, are not covered.";

/** ["5xx", "429"] → "5..|429". The values were checked at boot (OPS_HTTP_ERROR_STATUS in config.ts). */
export const statusRegex = (errorStatus: readonly string[]) =>
  errorStatus.map((status) => status.replace("xx", "..")).join("|");

export function httpQueries(naming: Naming, namespaces: string, errorStatus: readonly string[]) {
  const requests = `${naming.histogram}_count{${namespaces}}`;
  const errors = `${naming.histogram}_count{${namespaces},${naming.status}=~"${statusRegex(errorStatus)}"}`;
  const buckets = `${naming.histogram}_bucket{${namespaces}}`;
  const rateOf = (selector: string, window: string) => `sum by (${BY}) (rate(${selector}${window}))`;
  const p95Of = (window: string) => `histogram_quantile(0.95, sum by (${BY}, le) (rate(${buckets}${window})))`;
  return {
    requests: rateOf(requests, NOW),
    errors: rateOf(errors, NOW),
    p95: p95Of(NOW),
    usualRequests: rateOf(requests, USUAL),
    usualErrors: rateOf(errors, USUAL),
    usualP95: p95Of(USUAL),
  };
}

type Series = Readonly<Record<keyof ReturnType<typeof httpQueries>, readonly PromSample[]>>;

export interface HttpApp {
  readonly namespace: string;
  readonly app: string;
  readonly requests_per_s: number;
  readonly error_pct: number;
  readonly p95_ms: number | null;
  /** The same over the day before the last hour; null for an app without that history. */
  readonly usual_error_pct: number | null;
  readonly usual_p95_ms: number | null;
  readonly problems: readonly string[];
}
type Measured = Omit<HttpApp, "problems">;

type Labels = PromSample["labels"];
const appName = (labels: Labels) => labels.service ?? labels.job ?? "unknown";
const appKey = (labels: Labels) => [labels.namespace, labels.service, labels.job].join("/");
const percent = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;
const shareOf = (errorsPerS: number | undefined, requestsPerS: number | undefined) =>
  requestsPerS ? percent(errorsPerS ?? 0, requestsPerS) : null;
// histogram_quantile gives NaN for a window without requests.
const milliseconds = (seconds: number | undefined) =>
  seconds === undefined || Number.isNaN(seconds) ? null : Math.round(seconds * 1000);

function indexByApp(samples: readonly PromSample[]): ReadonlyMap<string, number> {
  return new Map(samples.map((sample) => [appKey(sample.labels), sample.value]));
}

function tooManyErrors(app: Measured, checks: HttpChecks): boolean {
  if (app.error_pct >= checks.errorPct) return true;
  const usual = app.usual_error_pct;
  if (usual === null || app.error_pct < UNUSUAL_ERRORS.minPct) return false;
  return app.error_pct >= usual * UNUSUAL_ERRORS.factor;
}

function tooSlow(app: Measured, checks: HttpChecks): boolean {
  if (app.p95_ms === null) return false;
  if (app.p95_ms >= checks.p95Ms) return true;
  const usual = app.usual_p95_ms;
  if (usual === null || app.p95_ms < UNUSUAL_P95.minMs) return false;
  return app.p95_ms >= usual * UNUSUAL_P95.factor;
}

function problemsOf(app: Measured, checks: HttpChecks): string[] {
  if (app.requests_per_s < MIN_REQUESTS_PER_S) return [];
  const problems: string[] = [];
  if (tooManyErrors(app, checks)) {
    const statuses = checks.errorStatus.join(" or ");
    const usually = app.usual_error_pct === null ? "" : `, usually ${app.usual_error_pct}%`;
    const traffic = `at ${app.requests_per_s} requests/s`;
    problems.push(`${app.error_pct}% of requests failed (${statuses}) in the last 5 minutes${usually}, ${traffic}`);
  }
  if (tooSlow(app, checks)) {
    const usually = app.usual_p95_ms === null ? "" : `, usually ${app.usual_p95_ms} ms`;
    problems.push(`p95 latency ${app.p95_ms} ms in the last 5 minutes${usually} (limit ${checks.p95Ms} ms)`);
  }
  return problems;
}

/** Joins the queries into one record per app. */
export function summarizeApps(series: Series, checks: HttpChecks): HttpApp[] {
  const errors = indexByApp(series.errors);
  const p95 = indexByApp(series.p95);
  const usualRequests = indexByApp(series.usualRequests);
  const usualErrors = indexByApp(series.usualErrors);
  const usualP95 = indexByApp(series.usualP95);

  return series.requests.map(({ labels, value: requestsPerS }) => {
    const key = appKey(labels);
    const measured = {
      namespace: labels.namespace ?? "",
      app: appName(labels),
      requests_per_s: Math.round(requestsPerS * 100) / 100,
      error_pct: shareOf(errors.get(key), requestsPerS) ?? 0,
      p95_ms: milliseconds(p95.get(key)),
      usual_error_pct: shareOf(usualErrors.get(key), usualRequests.get(key)),
      usual_p95_ms: milliseconds(usualP95.get(key)),
    };
    return { ...measured, problems: problemsOf(measured, checks) };
  });
}

const byUrgency = (a: HttpApp, b: HttpApp) =>
  b.problems.length - a.problems.length || b.requests_per_s - a.requests_per_s;

interface Query {
  readonly prom: PromClient;
  readonly matcher: string;
  readonly checks: HttpChecks;
  readonly signal: AbortSignal;
}

async function appsNamed(naming: Naming, { prom, matcher, checks, signal }: Query): Promise<HttpApp[]> {
  const queries = httpQueries(naming, matcher, checks.errorStatus);
  const run = (promql: string) => prom.query(promql, signal);
  const [requests, errors, p95, usualRequests, usualErrors, usualP95] = await Promise.all([
    run(queries.requests),
    run(queries.errors),
    run(queries.p95),
    run(queries.usualRequests),
    run(queries.usualErrors),
    run(queries.usualP95),
  ]);
  return summarizeApps({ requests, errors, p95, usualRequests, usualErrors, usualP95 }, checks);
}

export const promHttpHealth = defineTool({
  name: "prom_http_health",
  level: Level.Read,
  requires: ["prom", "k8s"],
  title: "Apps: HTTP error rate and latency",
  description:
    "Request rate, share of failed requests and p95 latency per app over the last 5 minutes, next to the usual " +
    "values (the day before the last hour), from the apps' request metrics in Prometheus. Lists problems (too " +
    "many errors or too slow, by the operator's limits or against usual) and puts those apps first. Use it " +
    "when users see errors or slowness, or when pods look healthy but the app misbehaves. Apps only, no routes.",
  input: {
    namespace: k8sLabel.optional(),
    limit: z.number().int().min(1).max(200).default(25),
  },
  timeoutMs: 8_000,

  async run({ namespace, limit }, { prom, k8s, httpChecks, signal }) {
    const query = { prom, matcher: namespaceMatcher(allowedNamespaces(k8s, namespace)), checks: httpChecks, signal };
    const perNaming = await Promise.all(NAMINGS.map((naming) => appsNamed(naming, query)));
    const apps = perNaming.flat().toSorted(byUrgency);
    if (apps.length === 0) return { total: 0, apps: [], note: NO_DATA };
    return { total: apps.length, apps: apps.slice(0, limit) };
  },
});
