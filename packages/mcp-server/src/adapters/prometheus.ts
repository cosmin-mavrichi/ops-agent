import { splitBasicAuth } from "../lib/basic-auth.js";
import { ConnectionError, httpGet } from "../lib/http-get.js";
import { type PromClient, type PromSample, ToolError } from "../types.js";

export interface PromConfig {
  /** Base URL of a Prometheus-compatible API, e.g. http://prometheus.monitoring:9090; may carry basic auth. */
  url: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface QueryResponse {
  status?: string;
  error?: string;
  data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
}

const UNREACHABLE =
  "The metrics server did not answer. Check that it is running and reachable from the ops agent " +
  "(OPS_PROM_URL); the other tools still work.";

/**
 * Read-only client for the Prometheus HTTP API: only GET /api/v1/query, the instant query. The API itself has
 * no write endpoints on that path, and tools send fixed PromQL with validated label values only.
 */
export function createPromClient(cfg: PromConfig): PromClient {
  const { base, authorization } = splitBasicAuth(cfg.url);
  const maxBytes = cfg.maxResponseBytes ?? 4 * 1024 * 1024;
  const timeoutMs = cfg.timeoutMs ?? 5_000;

  return {
    async query(promql, signal) {
      const url = new URL("api/v1/query", base);
      url.searchParams.set("query", promql);
      const headers = { accept: "application/json", ...(authorization ? { authorization } : {}) };
      const options = { headers, timeoutMs, maxBytes, signal, label: "prometheus /api/v1/query" };

      const { status, body } = await httpGet(url, options).catch((err: unknown) => {
        if (err instanceof ConnectionError && !signal?.aborted) throw new ToolError("unavailable", UNREACHABLE);
        throw err;
      });
      return parseVector(status, body);
    },
  };
}

/** Errors stay internal: a failing fixed query is our bug, and the server's message can name hosts. */
export function parseVector(status: number, body: string): PromSample[] {
  if (status === 401 || status === 403) {
    throw new ToolError("forbidden", "the metrics server refused the ops agent's credentials (OPS_PROM_URL)");
  }
  const parsed = JSON.parse(body) as QueryResponse;
  if (status !== 200 || parsed.status !== "success") {
    throw new Error(`prometheus query failed (${status}): ${parsed.error ?? "no message"}`);
  }
  if (parsed.data?.resultType !== "vector") {
    throw new Error(`prometheus returned ${parsed.data?.resultType ?? "nothing"}, expected a vector`);
  }
  return (parsed.data.result ?? []).map((series) => ({
    labels: series.metric ?? {},
    value: Number(series.value?.[1]),
  }));
}
