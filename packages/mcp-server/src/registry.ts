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
  const registered: string[] = [];
  const seen = new Set<string>();

  for (const def of defs) {
    if (seen.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`);
    seen.add(def.name);

    if (def.level > opts.maxLevel) continue; // not exposed at all — not just "denied"

    const timeoutMs = def.timeoutMs ?? opts.defaultTimeoutMs ?? 10_000;
    const maxChars = def.maxOutputChars ?? opts.defaultMaxOutputChars ?? 12_000;
    const schema = z.object(def.input).strict();

    const handler = async (rawArgs: unknown, ctx?: ServerContext): Promise<CallToolResult> => {
      const started = Date.now();
      const finish = (ok: boolean, args: unknown, error?: string) =>
        opts.audit?.({ tool: def.name, level: def.level, args, ok, durationMs: Date.now() - started, error });

      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        finish(false, rawArgs, "invalid_input");
        return errorResult("invalid_input", msg);
      }

      try {
        const data = await withTimeout(
          timeoutMs,
          (signal) => def.run(parsed.data, opts.context(signal)),
          ctx?.mcpReq.signal,
        );
        const text = truncate(opts.redact(JSON.stringify(data, null, 2)), maxChars);
        finish(true, parsed.data);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (err instanceof ToolError) {
          finish(false, parsed.data, err.code);
          return errorResult(err.code, opts.redact(err.message));
        }
        if (err instanceof TimeoutError) {
          finish(false, parsed.data, "timeout");
          return errorResult("timeout", `${def.name} did not finish within ${timeoutMs}ms`);
        }
        if (err instanceof CancelledError) {
          finish(false, parsed.data, "cancelled");
          return errorResult("cancelled", `${def.name} was cancelled by the client`);
        }
        // Unknown errors may carry connection strings, hosts, stack traces: log locally, show nothing.
        const detail = err instanceof Error ? err.message : String(err);
        finish(false, parsed.data, `internal: ${opts.redact(detail)}`);
        return errorResult("internal_error", `${def.name} failed; details are in the server log`);
      }
    };

    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // Strict: unknown keys are rejected, not silently stripped. The handler re-validates
        // so the pipeline is safe even if the SDK's validation behaviour changes.
        inputSchema: schema,
        annotations: {
          readOnlyHint: def.level === Level.Read,
          destructiveHint: def.level === Level.Dangerous,
          openWorldHint: false,
        },
      },
      handler as any,
    );
    registered.push(def.name);
  }
  return registered;
}

function errorResult(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] };
}
