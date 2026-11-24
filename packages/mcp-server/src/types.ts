import type { z } from "zod";

/** Tool levels. v1 builds the server with maxLevel = Read. */
export enum Level {
  Read = 1, // observe only
  Change = 2, // approved, reversible changes (restart, backup now, rollback)
  Dangerous = 3, // explicit approval every time (restore, schema change, major upgrade)
}

/**
 * The name the agent's own connections carry (Postgres application_name, Redis client name), so tools
 * can leave the agent out of what they report.
 */
export const AGENT_CLIENT_NAME = "ops-mcp";

export interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export type QueryParams = Readonly<Record<string, string | number | boolean | undefined>>;

/** Read-only Kubernetes API access. Paths are built by tools from validated names only. */
export interface K8sClient {
  /** Namespaces this deployment may inspect; RBAC grants the same set. */
  readonly namespaces: readonly string[];
  getJson<T>(path: string, signal?: AbortSignal, query?: QueryParams): Promise<T>;
  getText(path: string, signal?: AbortSignal, query?: QueryParams): Promise<string>;
}

/** Read-only Redis access. The adapter refuses any command outside its allowlist before sending it. */
export interface RedisClient {
  send(command: readonly string[], signal?: AbortSignal): Promise<unknown>;
}

/** One series of an instant query: its labels and current value. */
export interface PromSample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** Read-only Prometheus-compatible query API (Prometheus, VictoriaMetrics, Mimir, Thanos). Queries are fixed. */
export interface PromClient {
  query(promql: string, signal?: AbortSignal): Promise<PromSample[]>;
}

/** Read-only OpenSearch/Elasticsearch access. The adapter refuses any path outside its allowlist. */
export interface SearchClient {
  getJson<T>(path: string, query?: QueryParams, signal?: AbortSignal): Promise<T>;
}

export type Adapter = "pg" | "k8s" | "redis" | "prom" | "search";

/** When an app's HTTP traffic counts as a problem; set by the operator (OPS_HTTP_*). */
export interface HttpChecks {
  /** Status codes or classes that count as errors, e.g. ["5xx", "429"]. */
  readonly errorStatus: readonly string[];
  readonly errorPct: number;
  readonly p95Ms: number;
}

/** Everything a tool may touch. Tools never import adapters directly, so tests can pass fakes. */
export interface ToolContext {
  /** The adapters this deployment configured; calling any other one throws. */
  readonly adapters: readonly Adapter[];
  pg: SqlClient;
  k8s: K8sClient;
  redis: RedisClient;
  prom: PromClient;
  search: SearchClient;
  readonly httpChecks: HttpChecks;
  signal: AbortSignal;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * What a client sent back in a multi-round-trip call: the answers to the input a tool asked for, and the state
 * it handed out with them. Both arrive from the client; only a server that verifies requestState may trust it.
 */
export interface Round {
  readonly inputResponses?: Readonly<Record<string, unknown>>;
  readonly requestState?: unknown;
}

/**
 * `O` is what `run` returns, so a tool that builds on another (ops_triage) reads its output typed. `C` is the
 * context: the read server's ToolContext, or the write server's own.
 */
export interface ToolDef<S extends z.core.$ZodShape = z.core.$ZodShape, O = unknown, C = ToolContext> {
  name: string;
  level: Level;
  title: string;
  /** Written for the model: what it returns and when to use it. */
  description: string;
  input: S;
  /** Adapters the tool calls; a tool is only exposed when all of them are configured. */
  requires?: readonly Adapter[];
  timeoutMs?: number;
  maxOutputChars?: number;
  run(args: z.infer<z.ZodObject<S>>, ctx: C): Promise<O>;
}

/** Identity helper that keeps `args` typed from the zod shape and the output typed from `run`. */
export function defineTool<S extends z.core.$ZodShape, O, C = ToolContext>(def: ToolDef<S, O, C>): ToolDef<S, O, C> {
  return def;
}

/** Thrown by tools for expected failures; the message is safe to show the model. */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
