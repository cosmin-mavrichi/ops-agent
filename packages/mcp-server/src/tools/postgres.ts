import { z } from "zod";
import { Level, ToolError, defineTool } from "../types.js";

/** Whitelisted sort columns. User input selects a key; it is never interpolated. */
const ORDER_BY = {
  total_time: "s.total_exec_time",
  mean_time: "s.mean_exec_time",
  calls: "s.calls",
} as const;

const MAX_QUERY_TEXT = 1_500;

export const pgSlowQueries = defineTool({
  name: "pg_slow_queries",
  level: Level.Read,
  title: "Postgres: slowest queries",
  description:
    "Top statements from pg_stat_statements for the application database, with literals already " +
    "normalized to $1, $2… Use when latency is high, CPU is high, or a request times out. " +
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
        "unavailable",
        "pg_stat_statements is not installed in this database. It needs shared_preload_libraries " +
          "and CREATE EXTENSION — a setup step, not something to fix during an incident.",
      );
    }

    const info = await pg.query<{ stats_since: Date | null; dealloc: string | null }>(
      "SELECT stats_reset AS stats_since, dealloc::text FROM pg_stat_statements_info",
    );

    const rows = await pg.query<{
      queryid: string;
      query: string;
      calls: string;
      total_ms: string;
      mean_ms: string;
      max_ms: string;
      rows: string;
      hit_ratio: string | null;
      temp_mb: string;
    }>(
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

    return {
      database_window: { stats_since: info[0]?.stats_since ?? null, evicted_entries: Number(info[0]?.dealloc ?? 0) },
      order_by,
      queries: rows.map((r) => ({
        queryid: r.queryid,
        query: r.query,
        calls: Number(r.calls),
        total_ms: Number(r.total_ms),
        mean_ms: Number(r.mean_ms),
        max_ms: Number(r.max_ms),
        rows_per_call: Number(r.calls) > 0 ? +(Number(r.rows) / Number(r.calls)).toFixed(1) : 0,
        cache_hit_pct: r.hit_ratio === null ? null : Number(r.hit_ratio),
        temp_spill_mb: Number(r.temp_mb),
      })),
    };
  },
});
