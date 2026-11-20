import type { z } from "zod";

/** Tool levels. v1 builds the server with maxLevel = Read. */
export enum Level {
  Read = 1, // observe only
  Change = 2, // approved, reversible changes (restart, backup now, rollback)
  Dangerous = 3, // explicit approval every time (restore, schema change, major upgrade)
}

export interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export type QueryParams = Readonly<Record<string, string | number | boolean | undefined>>;

/** Read-only Kubernetes API access. Paths are built by tools from validated names only. */
export interface K8sClient {
  /** Namespaces this deployment may inspect; RBAC grants the same set. */
  readonly namespaces: readonly string[];
  getJson<T>(path: string, query?: QueryParams, signal?: AbortSignal): Promise<T>;
  getText(path: string, query?: QueryParams, signal?: AbortSignal): Promise<string>;
}

export type Adapter = "pg" | "k8s";

/** Everything a tool may touch. Tools never import adapters directly, so tests can pass fakes. */
export interface ToolContext {
  pg: SqlClient;
  k8s: K8sClient;
  signal: AbortSignal;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
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
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>;
}

/** Identity helper that keeps `args` typed from the zod shape. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
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
