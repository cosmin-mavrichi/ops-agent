import { stripLiterals } from "../../lib/sql-text.js";

const MAX_QUERY_TEXT = 1_000;

/** Columns shared by both tools; durations are whole seconds, query text is fetched raw and stripped in code. */
export const SESSION_COLUMNS = `
  a.pid,
  a.datname                                            AS database,
  a.usename                                            AS user_name,
  a.application_name,
  host(a.client_addr)                                  AS client_addr,
  a.backend_type,
  a.state,
  a.wait_event_type,
  a.wait_event,
  extract(epoch FROM now() - a.xact_start)::int        AS xact_age_s,
  extract(epoch FROM now() - a.query_start)::int       AS query_age_s,
  extract(epoch FROM now() - a.state_change)::int      AS state_age_s,
  pg_blocking_pids(a.pid)                              AS blocked_by,
  left(a.query, ${MAX_QUERY_TEXT * 4})                 AS query`;

export interface SessionRow extends Record<string, unknown> {
  pid: number;
  database: string | null;
  user_name: string | null;
  application_name: string | null;
  client_addr: string | null;
  backend_type: string | null;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  xact_age_s: number | null;
  query_age_s: number | null;
  state_age_s: number | null;
  blocked_by: number[];
  query: string | null;
}

export function toSession(row: SessionRow) {
  return {
    pid: row.pid,
    database: row.database,
    user: row.user_name,
    application: row.application_name || null,
    client_addr: row.client_addr,
    state: row.state,
    wait: row.wait_event_type ? `${row.wait_event_type}:${row.wait_event}` : null,
    transaction_age_s: row.xact_age_s,
    query_age_s: row.query_age_s,
    in_state_s: row.state_age_s,
    blocked_by: row.blocked_by,
    query: row.query ? stripLiterals(row.query).slice(0, MAX_QUERY_TEXT) : null,
  };
}
