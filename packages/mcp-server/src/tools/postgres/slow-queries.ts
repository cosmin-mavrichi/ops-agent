import { z } from "zod";
import { stripLiterals } from "../../lib/sql-text.js";
import { defineTool, Level, ToolError } from "../../types.js";

/** Whitelisted sort columns. User input selects a key; it is never interpolated. */
const ORDER_BY = {
  total_time: "s.total_exec_time",
  mean_time: "s.mean_exec_time",
  calls: "s.calls",
} as const;

const MAX_QUERY_TEXT = 1_500;
const SHOWN_QUERY_TEXT = 300;

/**
 * Statement text as the model sees it. pg_stat_statements normalizes literals in ordinary statements but keeps
 * utility statements (ALTER ROLE ... PASSWORD '...') and comments verbatim, and comments are free text that can
 * carry instructions aimed at the model: stripLiterals drops both. The start of a statement identifies it, so
 * the rest is clipped, which cannot cut a secret in half once no literal is left.
 */
export function shownQueryText(query: string): string {
  const flat = stripLiterals(query).replace(/\s+/g, " ").trim();
  return flat.length > SHOWN_QUERY_TEXT ? `${flat.slice(0, SHOWN_QUERY_TEXT)}…` : flat;
}

/** Numeric columns come back as text so bigints survive; they are converted here. */
interface StatementRow extends Record<string, unknown> {
  queryid: string;
  query: string;
  calls: string;
  total_ms: string;
  mean_ms: string;
  max_ms: string;
  rows: string;
  hit_ratio: string | null;
  temp_mb: string;
}

function toStatement(row: StatementRow) {
  const calls = Number(row.calls);
  const rowsPerCall = calls > 0 ? Number(row.rows) / calls : 0;
  return {
    queryid: row.queryid,
    query: shownQueryText(row.query),
    calls,
    total_ms: Number(row.total_ms),
    mean_ms: Number(row.mean_ms),
    max_ms: Number(row.max_ms),
    rows_per_call: Math.round(rowsPerCall * 10) / 10,
    cache_hit_pct: row.hit_ratio === null ? null : Number(row.hit_ratio),
    temp_spill_mb: Number(row.temp_mb),
  };
}

export const pgSlowQueries = defineTool({
  name: "pg_slow_queries",
  level: Level.Read,
  requires: ["pg"],
  title: "Postgres: slowest queries",
  description:
    "Top statements from pg_stat_statements for the application database: literals replaced ($1 or ?), " +
    "comments removed, text cut to its first 300 characters. Use when latency is high, CPU is high, or a " +
    "request times out. " +
    "`total_time` finds what costs the most overall; `mean_time` finds individually slow statements; " +
    "`calls` finds chatty N+1 patterns. Stats are cumulative since `stats_since`.",
  input: {
    limit: z.number().int().min(1).max(20).default(10),
    order_by: z.enum(["total_time", "mean_time", "calls"]).default("total_time"),
  },
  timeoutMs: 8_000,

  async run({ limit, order_by }, { pg }) {
    const ext = await pg.query<{ ok: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS ok",
    );
    if (!ext[0]?.ok) {
      throw new ToolError(
        "not_installed",
        "pg_stat_statements is not installed in this database. It needs shared_preload_libraries " +
          "and CREATE EXTENSION — a setup step, not something to fix during an incident.",
      );
    }

    const info = await pg.query<{ stats_since: Date | null; dealloc: string | null }>(
      "SELECT stats_reset AS stats_since, dealloc::text FROM pg_stat_statements_info",
    );

    const rows = await pg.query<StatementRow>(
      `SELECT s.queryid::text                                  AS queryid,
              left(s.query, ${MAX_QUERY_TEXT})                 AS query,
              s.calls::text                                    AS calls,
              round(s.total_exec_time::numeric, 1)::text       AS total_ms,
              round(s.mean_exec_time::numeric, 2)::text        AS mean_ms,
              round(s.max_exec_time::numeric, 1)::text         AS max_ms,
              s.rows::text                                     AS rows,
              round(100.0 * s.shared_blks_hit
                    / nullif(s.shared_blks_hit + s.shared_blks_read, 0), 1)::text AS hit_ratio,
              round((s.temp_blks_written * current_setting('block_size')::numeric) / 1048576, 1)::text AS temp_mb
         FROM pg_stat_statements s
         JOIN pg_database d ON d.oid = s.dbid
        WHERE d.datname = current_database()
          AND s.toplevel
          AND s.query !~* '(pg_stat_statements|pg_stat_activity|pg_extension)'
        ORDER BY ${ORDER_BY[order_by]} DESC
        LIMIT $1`,
      [limit],
    );

    const [window] = info;
    return {
      database_window: { stats_since: window?.stats_since ?? null, evicted_entries: Number(window?.dealloc ?? 0) },
      order_by,
      queries: rows.map(toStatement),
    };
  },
});
