import { z } from "zod";
import type { Policy } from "./incidents.js";

const Env = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  OPS_WATCH_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  OPS_WATCH_INTERVAL_S: z.coerce.number().int().min(10).max(3_600).default(60),
  /** Checks in a row a problem must be gone before its incident is resolved. */
  OPS_WATCH_RESOLVE_AFTER_CHECKS: z.coerce.number().int().min(1).max(100).default(3),
  OPS_WATCH_MAX_PER_HOUR: z.coerce.number().int().min(0).max(100).default(3),
  OPS_WATCH_MAX_PER_DAY: z.coerce.number().int().min(0).max(1_000).default(10),
  /** Per investigation: the agent stops once it has spent this much. */
  OPS_WATCH_MAX_COST_USD: z.coerce.number().positive().max(5).default(0.05),
  OPS_WATCH_MAX_TURNS: z.coerce.number().int().min(1).max(50).default(12),
  /** Comma-separated, case-insensitive substrings of "tool: problem" for known, accepted problems. */
  OPS_WATCH_IGNORE: z.string().default(""),
  /** Also append each report as a JSON line to this file (e.g. on a mounted volume). */
  OPS_WATCH_REPORT_FILE: z.string().min(1).optional(),
  /** The built MCP server entry point; defaults to the one next to the watcher in this repo or image. */
  OPS_WATCH_SERVER: z.string().min(1).optional(),
  /** Shared with the server: tells the agent which namespaces it may inspect. */
  OPS_K8S_NAMESPACES: z.string().default(""),
});

const splitList = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv, defaults: { readonly server: string }) {
  const vars = Env.parse(env);
  const policy: Policy = {
    ignore: splitList(vars.OPS_WATCH_IGNORE),
    resolveAfterChecks: vars.OPS_WATCH_RESOLVE_AFTER_CHECKS,
    maxPerHour: vars.OPS_WATCH_MAX_PER_HOUR,
    maxPerDay: vars.OPS_WATCH_MAX_PER_DAY,
  };
  return {
    apiKey: vars.ANTHROPIC_API_KEY,
    model: vars.OPS_WATCH_MODEL,
    intervalMs: vars.OPS_WATCH_INTERVAL_S * 1_000,
    maxCostUsd: vars.OPS_WATCH_MAX_COST_USD,
    maxTurns: vars.OPS_WATCH_MAX_TURNS,
    reportFile: vars.OPS_WATCH_REPORT_FILE,
    server: vars.OPS_WATCH_SERVER ?? defaults.server,
    namespaces: splitList(vars.OPS_K8S_NAMESPACES),
    policy,
  };
}

export type WatchConfig = ReturnType<typeof loadConfig>;
