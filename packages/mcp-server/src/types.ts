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

/** Everything a tool may touch. Tools never import adapters directly, so tests can pass fakes. */
export interface ToolContext {
  pg: SqlClient;
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
