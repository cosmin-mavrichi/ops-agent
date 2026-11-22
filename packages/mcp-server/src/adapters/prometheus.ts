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
  const { endpoint, authorization } = splitCredentials(cfg.url);
  const maxBytes = cfg.maxResponseBytes ?? 4 * 1024 * 1024;
  const timeoutMs = cfg.timeoutMs ?? 5_000;

  return {
    async query(promql, signal) {
      const url = new URL("api/v1/query", endpoint);
      url.searchParams.set("query", promql);
      const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
      const headers = { accept: "application/json", ...(authorization ? { authorization } : {}) };

      const response = await fetch(url, { headers, signal: AbortSignal.any(signals) }).catch((err: unknown) => {
        if (signal?.aborted) throw err;
        throw new ToolError("unavailable", UNREACHABLE);
      });
      const body = await readCapped(response, maxBytes);
      return parseVector(response.status, body);
    },
  };
}

/** fetch refuses URLs with credentials, so basic auth moves into a header. */
function splitCredentials(raw: string): { endpoint: URL; authorization?: string } {
  const endpoint = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  if (!endpoint.username && !endpoint.password) return { endpoint };

  const user = decodeURIComponent(endpoint.username);
  const password = decodeURIComponent(endpoint.password);
  endpoint.username = "";
  endpoint.password = "";
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  return { endpoint, authorization };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`prometheus response over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
