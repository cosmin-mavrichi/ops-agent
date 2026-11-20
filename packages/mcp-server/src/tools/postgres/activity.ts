import { z } from "zod";
import { defineTool, Level } from "../../types.js";
import { SESSION_COLUMNS, type SessionRow, toSession } from "./shared.js";

interface ConnectionTotals extends Record<string, unknown> {
  max_connections: number;
  reserved: number;
  total: number;
  active: number;
  idle: number;
  idle_in_transaction: number;
  waiting_on_lock: number;
}

/** Share of the connections applications can use; superuser_reserved_connections are not theirs. */
function usedPercent(totals: ConnectionTotals | undefined): number | null {
  if (!totals) return null;
  const usable = totals.max_connections - totals.reserved;
  return usable > 0 ? Math.round((100 * totals.total) / usable) : null;
}

export const pgActivity = defineTool({
  name: "pg_activity",
  level: Level.Read,
  requires: ["pg"],
  title: "Postgres: connections and live sessions",
  description:
    "What Postgres is doing right now. Returns connection usage against max_connections (by state and by " +
    "user/application), then the non-idle sessions oldest first: running queries, and sessions 'idle in " +
    "transaction' that hold locks and block vacuum. Use for timeouts, 'too many connections', stuck requests " +
    "or rising latency. Literals in query text are replaced with ?. For lock chains use pg_blocking.",
  input: {
    min_age_s: z.number().int().min(0).max(86_400).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  },
  timeoutMs: 8_000,

  async run({ min_age_s, limit }, { pg }) {
    const [totals] = await pg.query<ConnectionTotals>(
      `SELECT current_setting('max_connections')::int                                AS max_connections,
              current_setting('superuser_reserved_connections')::int                 AS reserved,
              count(*)::int                                                          AS total,
              count(*) FILTER (WHERE state = 'active')::int                          AS active,
              count(*) FILTER (WHERE state = 'idle')::int                            AS idle,
              count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int         AS idle_in_transaction,
              count(*) FILTER (WHERE wait_event_type = 'Lock')::int                  AS waiting_on_lock
         FROM pg_stat_activity
        WHERE backend_type = 'client backend'`,
    );

    const byClient = await pg.query<{ user_name: string | null; application_name: string; n: number }>(
      `SELECT usename AS user_name, application_name, count(*)::int AS n
         FROM pg_stat_activity
        WHERE backend_type = 'client backend'
        GROUP BY 1, 2
        ORDER BY n DESC
        LIMIT 10`,
    );

    const sessions = await pg.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM pg_stat_activity a
        WHERE a.backend_type = 'client backend'
          AND a.pid <> pg_backend_pid()
          AND a.state IS DISTINCT FROM 'idle'
          AND now() - coalesce(a.xact_start, a.query_start) >= make_interval(secs => $1)
        ORDER BY coalesce(a.xact_start, a.query_start) ASC NULLS LAST
        LIMIT $2`,
      [min_age_s, limit],
    );

    const topClients = byClient.map((client) => ({
      user: client.user_name,
      application: client.application_name || null,
      connections: client.n,
    }));

    return {
      connections: { ...totals, used_pct: usedPercent(totals), top_clients: topClients },
      sessions: sessions.map(toSession),
    };
  },
});
