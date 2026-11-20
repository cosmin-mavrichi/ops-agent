import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions, request } from "node:https";
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
    const options: RequestOptions = {
      method: "GET",
      ca: cfg.ca,
      headers: { authorization: `Bearer ${cfg.token()}`, accept },
      timeout: cfg.timeoutMs ?? 5_000,
      signal,
    };
    const { req, res } = await sendRequest(buildUrl(cfg.server, path, query), options, path);
    const body = await readBody(req, res, maxBytes, path);
    const status = res.statusCode ?? 0;
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

interface Exchange {
  readonly req: ClientRequest;
  readonly res: IncomingMessage;
}

/** Resolves once the response headers arrive. */
function sendRequest(url: URL, options: RequestOptions, path: string): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => resolve({ req, res }));
    req.on("timeout", () => req.destroy(new Error(`kubernetes request timed out for ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

/** Reads the whole body, failing past maxBytes or when the connection drops before the end. */
function readBody(req: ClientRequest, res: IncomingMessage, maxBytes: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // A timeout or abort mid-body is reported on the request; the response only sees "aborted".
    req.on("error", reject);
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) res.destroy(new Error(`kubernetes response over ${maxBytes} bytes for ${path}`));
      else chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
    // Timeouts and aborts destroy the request; the response then closes without "end".
    res.on("close", () => {
      if (!res.complete) reject(new Error(`kubernetes response for ${path} ended early`));
    });
  });
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
