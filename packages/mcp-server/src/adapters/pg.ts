import pg from "pg";
import type { SqlClient } from "../types.js";

export interface PgConfig {
  connectionString: string; // must use the ops_ro role (see deploy/sql/ops_ro.sql)
  statementTimeoutMs?: number;
  /** Idle connections can fail (e.g. Postgres restarts); without a handler Node crashes the process. */
  onError: (err: Error) => void;
}

/**
 * Read-only Postgres client. Defence in depth:
 *  1. the ops_ro role has pg_monitor and no table privileges,
 *  2. every session is read-only with a statement timeout,
 *  3. tools only run fixed SQL with bound parameters.
 */
export function createPgClient(cfg: PgConfig): SqlClient & { end(): Promise<void> } {
  const timeout = cfg.statementTimeoutMs ?? 5_000;
  const pool = new pg.Pool({
    connectionString: cfg.connectionString,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    application_name: "ops-mcp",
    options: `-c default_transaction_read_only=on -c statement_timeout=${timeout} -c lock_timeout=1000`,
  });
  pool.on("error", cfg.onError);

  return {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    end: () => pool.end(),
  };
}
