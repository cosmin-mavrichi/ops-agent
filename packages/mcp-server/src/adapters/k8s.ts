import { httpGet } from "../lib/http-get.js";
import { type K8sClient, type QueryParams, ToolError } from "../types.js";

export interface K8sConfig {
  /** API server base URL, e.g. https://10.43.0.1:443 in-cluster. */
  server: string;
  /** PEM CA bundle that signed the API server certificate. */
  ca: string;
  /** Called per request: projected ServiceAccount tokens rotate, so never cache the value. */
  token: () => string;
  namespaces: readonly string[];
  /** How long the connection may stay silent before the request fails. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const ACCEPT_JSON = "application/json";
// Log bodies are plain text, but the API only negotiates JSON-family types (it answers errors as JSON).
const ACCEPT_JSON_OR_TEXT = "application/json, */*";

/**
 * Read-only Kubernetes client: GET only, authenticated as a ServiceAccount whose RBAC allows
 * get/list/watch on pods, pods/log and events (deploy/k8s/ops-ro.yaml). No exec, no writes.
 */
export function createK8sClient(cfg: K8sConfig): K8sClient {
  const maxBytes = cfg.maxResponseBytes ?? 4 * 1024 * 1024;

  async function get(path: string, accept: string, signal?: AbortSignal, query: QueryParams = {}) {
    const { status, body } = await httpGet(buildUrl(cfg.server, path, query), {
      headers: { authorization: `Bearer ${cfg.token()}`, accept },
      ca: cfg.ca,
      timeoutMs: cfg.timeoutMs ?? 5_000,
      maxBytes,
      signal,
      label: `kubernetes ${path}`,
    });
    if (status < 200 || status >= 300) throw statusError(status, path, body);
    return body;
  }

  return {
    namespaces: cfg.namespaces,
    getJson: async <T>(path: string, signal?: AbortSignal, query?: QueryParams) =>
      JSON.parse(await get(path, ACCEPT_JSON, signal, query)) as T,
    getText: (path, signal, query) => get(path, ACCEPT_JSON_OR_TEXT, signal, query),
  };
}

function buildUrl(server: string, path: string, query: QueryParams): URL {
  const url = new URL(path, server);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

/** Maps API errors the model can act on to ToolErrors; anything else stays internal. */
export function statusError(status: number, path: string, body: string): Error {
  const message = apiMessage(body);
  if (status === 400) return new ToolError("invalid_request", message ?? `bad request for ${path}`);
  if (status === 403) return new ToolError("forbidden", `the ops ServiceAccount is not allowed to read ${path}`);
  if (status === 404) return new ToolError("not_found", `${path} does not exist`);
  return new Error(`kubernetes API returned ${status} for ${path}: ${message ?? "no message"}`);
}

function apiMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : undefined;
  } catch {
    return body.trim().slice(0, 300) || undefined;
  }
}
