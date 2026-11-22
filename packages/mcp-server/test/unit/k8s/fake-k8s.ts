import type { K8sClient } from "../../../src/types.js";

export const NOW = new Date("2026-11-20T12:00:00Z");
export const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

/** Fake API that records requests and answers by path; a function answer receives the query. */
export function fakeK8s(responses: Record<string, unknown> = {}, namespaces = ["app", "jobs"]) {
  const calls: Array<{ path: string; query: Record<string, unknown> }> = [];
  const answer = (path: string, query: Record<string, unknown> = {}) => {
    calls.push({ path, query });
    const match = Object.keys(responses).find((suffix) => path.endsWith(suffix));
    if (match === undefined) return { items: [] };
    const response = responses[match];
    return typeof response === "function" ? response(query) : response;
  };
  const client: K8sClient = {
    namespaces,
    getJson: async <T>(path: string, _signal?: AbortSignal, query?: Record<string, unknown>) =>
      answer(path, query) as T,
    getText: async (path, _signal, query) => answer(path, query) as string,
  };
  return { client, calls };
}
