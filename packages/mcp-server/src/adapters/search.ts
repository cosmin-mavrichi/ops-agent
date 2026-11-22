import { splitBasicAuth } from "../lib/basic-auth.js";
import { ConnectionError, httpGet } from "../lib/http-get.js";
import { type QueryParams, type SearchClient, ToolError } from "../types.js";

export interface SearchConfig {
  /** OpenSearch or Elasticsearch URL as the ops_ro user (deploy/search/<engine>-ops-ro.json). */
  url: string;
  /** PEM CA bundle when the cluster's certificate is self-signed. */
  ca?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Diagnostic endpoints the tools may read. No document, search or _cat/indices-by-pattern paths. */
const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/_cluster/health",
  "/_cluster/allocation/explain",
  "/_cluster/settings",
  "/_cat/allocation",
  "/_all/_settings/index.blocks.*",
]);

export const isAllowedPath = (path: string) => ALLOWED_PATHS.has(path);

const UNREACHABLE =
  "The search cluster did not answer. Check that it is running and reachable from the ops agent " +
  "(OPS_SEARCH_URL); the other tools still work.";

/**
 * Read-only OpenSearch/Elasticsearch client. Defence in depth:
 *  1. the ops_ro role has only cluster and index `monitor` privileges: no document reads,
 *  2. this adapter sends GET only, and only to the paths above,
 *  3. tools return the fields they need, never documents or mappings.
 */
export function createSearchClient(cfg: SearchConfig): SearchClient {
  const { base, authorization } = splitBasicAuth(cfg.url);
  const maxBytes = cfg.maxResponseBytes ?? 4 * 1024 * 1024;

  return {
    async getJson<T>(path: string, query: QueryParams = {}, signal?: AbortSignal) {
      if (!isAllowedPath(path)) throw new Error(`search path not allowed: ${path}`);
      const url = new URL(path.slice(1), base);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const headers = { accept: "application/json", ...(authorization ? { authorization } : {}) };
      const options = { headers, ca: cfg.ca, timeoutMs: cfg.timeoutMs ?? 5_000, maxBytes, signal };
      const { status, body } = await httpGet(url, { ...options, label: `search ${path}` }).catch((err: unknown) => {
        if (err instanceof ConnectionError && !signal?.aborted) throw new ToolError("unavailable", UNREACHABLE);
        throw err;
      });
      if (status === 401 || status === 403) {
        throw new ToolError("forbidden", `the ops_ro user may not read ${path}; see deploy/search/`);
      }
      if (status < 200 || status >= 300) throw new Error(`search returned ${status} for ${path}`);
      return JSON.parse(body) as T;
    },
  };
}
