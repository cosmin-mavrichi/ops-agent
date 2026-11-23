import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CancelledError, TimeoutError, truncate, withTimeout } from "./lib/limits.js";
import type { Redactor } from "./lib/redact.js";
import { Level, type ToolContext, type ToolDef, ToolError } from "./types.js";

export interface AuditEntry {
  tool: string;
  level: Level;
  args: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface RegistryOptions {
  /** Highest level this build exposes. v1 = Level.Read. Tools above it are never registered. */
  maxLevel: Level;
  redact: Redactor;
  /** Builds the per-call context (fresh AbortSignal each call). */
  context: (signal: AbortSignal) => ToolContext;
  audit?: (entry: AuditEntry) => void;
  defaultTimeoutMs?: number;
  defaultMaxOutputChars?: number;
}

/**
 * Registers tools on the MCP server. Every call goes through the same pipeline:
 * validate → run with timeout → serialize → redact → truncate → audit.
 * Returns the names actually registered, so tests can assert the exposed surface.
 */
export function registerTools(server: McpServer, defs: ToolDef<any>[], opts: RegistryOptions): string[] {
  assertUniqueNames(defs);
  // Tools above maxLevel are not exposed at all, rather than listed and then denied.
  const exposed = defs.filter((def) => def.level <= opts.maxLevel);
  for (const def of exposed) registerTool(server, def, opts);
  return exposed.map((def) => def.name);
}

function assertUniqueNames(defs: readonly ToolDef<any>[]): void {
  const seen = new Set<string>();
  for (const { name } of defs) {
    if (seen.has(name)) throw new Error(`duplicate tool name: ${name}`);
    seen.add(name);
  }
}

function registerTool(server: McpServer, def: ToolDef<any>, opts: RegistryOptions): void {
  // Strict: unknown keys are rejected, not silently stripped.
  const schema = z.object(def.input).strict();
  const config = {
    title: def.title,
    description: def.description,
    inputSchema: schema,
    annotations: {
      readOnlyHint: def.level === Level.Read,
      destructiveHint: def.level === Level.Dangerous,
      openWorldHint: false,
    },
  };
  server.registerTool(def.name, config, createHandler(def, schema, opts) as any);
}

function createHandler(def: ToolDef<any>, schema: z.ZodObject<z.core.$ZodShape>, opts: RegistryOptions) {
  const timeoutMs = def.timeoutMs ?? opts.defaultTimeoutMs ?? 10_000;
  const maxChars = def.maxOutputChars ?? opts.defaultMaxOutputChars ?? 12_000;

  return async (rawArgs: unknown, ctx?: ServerContext): Promise<CallToolResult> => {
    const started = Date.now();
    const audit = (args: unknown, error?: string) =>
      opts.audit?.({
        tool: def.name,
        level: def.level,
        args,
        ok: error === undefined,
        durationMs: Date.now() - started,
        error,
      });

    // Re-validated here so the pipeline stays safe even if the SDK's own validation changes.
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      audit(rawArgs, "invalid_input");
      return errorResult("invalid_input", describeIssues(parsed.error));
    }

    try {
      const run = (signal: AbortSignal) => def.run(parsed.data, opts.context(signal));
      const data = await withTimeout(timeoutMs, run, ctx?.mcpReq.signal);
      const text = truncate(serializeRedacted(data, opts.redact), maxChars);
      audit(parsed.data);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const failure = describeFailure(err, def.name, timeoutMs, opts.redact);
      audit(parsed.data, failure.auditCode);
      return errorResult(failure.code, failure.message);
    }
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * Redacts each string before serializing: redacting the JSON text can swallow a closing quote,
 * and misses secrets that JSON escapes. No indentation: the model reads compact JSON as well, and
 * indentation was about an eighth of the tokens it paid for.
 */
function serializeRedacted(data: unknown, redact: Redactor): string {
  const redactStrings = (_key: string, value: unknown) => (typeof value === "string" ? redact(value) : value);
  return JSON.stringify(data, redactStrings);
}

interface Failure {
  /** Shown to the model. */
  readonly code: string;
  readonly message: string;
  /** Kept in the local audit log only. */
  readonly auditCode: string;
}

function describeFailure(err: unknown, tool: string, timeoutMs: number, redact: Redactor): Failure {
  if (err instanceof ToolError) {
    return { code: err.code, message: redact(err.message), auditCode: err.code };
  }
  if (err instanceof TimeoutError) {
    return { code: "timeout", message: `${tool} did not finish within ${timeoutMs}ms`, auditCode: "timeout" };
  }
  if (err instanceof CancelledError) {
    return { code: "cancelled", message: `${tool} was cancelled by the client`, auditCode: "cancelled" };
  }
  // Unknown errors may carry connection strings, hosts, stack traces: log locally, show nothing.
  const detail = err instanceof Error ? err.message : String(err);
  return {
    code: "internal_error",
    message: `${tool} failed; details are in the server log`,
    auditCode: `internal: ${redact(detail)}`,
  };
}

function errorResult(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] };
}
