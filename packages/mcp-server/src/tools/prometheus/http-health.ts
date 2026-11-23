import { z } from "zod";
import { defineTool, type HttpChecks, Level, type PromClient, type PromSample } from "../../types.js";
import { allowedNamespaces, k8sLabel } from "../k8s/shared.js";
import { namespaceMatcher } from "./volume-usage.js";

const WINDOW = "5m";
/** Below this (30 requests in the window) an error share or a p95 rests on a handful of requests. */
const MIN_REQUESTS_PER_S = 0.1;

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
  return {
    requests: `sum by (${BY}) (rate(${requests}[${WINDOW}]))`,
    errors: `sum by (${BY}) (rate(${errors}[${WINDOW}]))`,
    p95: `histogram_quantile(0.95, sum by (${BY}, le) (rate(${buckets}[${WINDOW}])))`,
  };
}

type Series = Readonly<Record<keyof ReturnType<typeof httpQueries>, readonly PromSample[]>>;

export interface HttpApp {
  readonly namespace: string;
  readonly app: string;
  readonly requests_per_s: number;
  readonly error_pct: number;
  readonly p95_ms: number | null;
  readonly problems: readonly string[];
}

type Labels = PromSample["labels"];
const appName = (labels: Labels) => labels.service ?? labels.job ?? "unknown";
const appKey = (labels: Labels) => [labels.namespace, labels.service, labels.job].join("/");
const percent = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;

function indexByApp(samples: readonly PromSample[]): ReadonlyMap<string, number> {
  return new Map(samples.map((sample) => [appKey(sample.labels), sample.value]));
}

function problemsOf(app: Omit<HttpApp, "problems">, checks: HttpChecks): string[] {
  if (app.requests_per_s < MIN_REQUESTS_PER_S) return [];
  const problems: string[] = [];
  if (app.error_pct >= checks.errorPct) {
    const statuses = checks.errorStatus.join(" or ");
    const traffic = `${app.requests_per_s} requests/s`;
    problems.push(`${app.error_pct}% of requests failed (${statuses}) in the last 5 minutes, at ${traffic}`);
  }
  if (app.p95_ms !== null && app.p95_ms >= checks.p95Ms) {
    problems.push(`p95 latency ${app.p95_ms} ms in the last 5 minutes (limit ${checks.p95Ms} ms)`);
  }
  return problems;
}

/** Joins the three queries into one record per app. */
export function summarizeApps(series: Series, checks: HttpChecks): HttpApp[] {
  const errors = indexByApp(series.errors);
  const p95 = indexByApp(series.p95);

  return series.requests.map(({ labels, value: requestsPerS }) => {
    const key = appKey(labels);
    const errorsPerS = errors.get(key) ?? 0;
    // NaN when there were no requests in the window.
    const p95Seconds = p95.get(key) ?? Number.NaN;
    const measured = {
      namespace: labels.namespace ?? "",
      app: appName(labels),
      requests_per_s: Math.round(requestsPerS * 100) / 100,
      error_pct: requestsPerS > 0 ? percent(errorsPerS, requestsPerS) : 0,
      p95_ms: Number.isNaN(p95Seconds) ? null : Math.round(p95Seconds * 1000),
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
  const [requests, errors, p95] = await Promise.all([
    prom.query(queries.requests, signal),
    prom.query(queries.errors, signal),
    prom.query(queries.p95, signal),
  ]);
  return summarizeApps({ requests, errors, p95 }, checks);
}

export const promHttpHealth = defineTool({
  name: "prom_http_health",
  level: Level.Read,
  requires: ["prom", "k8s"],
  title: "Apps: HTTP error rate and latency",
  description:
    "Request rate, share of failed requests and p95 latency per app over the last 5 minutes, from the apps' " +
    "request metrics in Prometheus. Lists problems (too many errors, too slow) and puts those apps first. Use it " +
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
