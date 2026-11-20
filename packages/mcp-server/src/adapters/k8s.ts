import { request } from "node:https";
import { type K8sClient, type QueryParams, ToolError } from "../types.js";

export interface K8sConfig {
  /** API server base URL, e.g. https://10.43.0.1:443 in-cluster. */
  server: string;
  /** PEM CA bundle that signed the API server certificate. */
  ca: string;
  /** Called per request: projected ServiceAccount tokens rotate, so never cache the value. */
  token: () => string;
  namespaces: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Read-only Kubernetes client: GET only, authenticated as a ServiceAccount whose RBAC allows
 * get/list/watch on pods, pods/log and events (deploy/k8s/ops-ro.yaml). No exec, no writes.
 */
export function createK8sClient(cfg: K8sConfig): K8sClient {
  const maxBytes = cfg.maxResponseBytes ?? 4 * 1024 * 1024;

  const get = (path: string, query: QueryParams, accept: string, signal?: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const url = new URL(path, cfg.server);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      const req = request(
        url,
        {
          method: "GET",
          ca: cfg.ca,
          headers: { authorization: `Bearer ${cfg.token()}`, accept },
          timeout: cfg.timeoutMs ?? 5_000,
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) req.destroy(new Error(`kubernetes response over ${maxBytes} bytes for ${path}`));
            else chunks.push(chunk);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve(body);
            else reject(statusError(status, path, body));
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`kubernetes request timed out for ${path}`)));
      req.on("error", reject);
      req.end();
    });

  return {
    namespaces: cfg.namespaces,
    getJson: async <T>(path: string, query: QueryParams = {}, signal?: AbortSignal) =>
      JSON.parse(await get(path, query, "application/json", signal)) as T,
    // Log bodies are plain text, but the API only negotiates JSON-family types (it answers errors as JSON).
    getText: (path, query = {}, signal) => get(path, query, "application/json, */*", signal),
  };
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
