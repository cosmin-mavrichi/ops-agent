import { z } from "zod";
import { stripLiterals } from "../../lib/sql-text.js";
import { defineTool, Level } from "../../types.js";

const MAX_QUERY_TEXT = 1_000;

/** Columns shared by both tools; durations are whole seconds, query text is fetched raw and stripped in code. */
const SESSION_COLUMNS = `
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

interface SessionRow extends Record<string, unknown> {
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

function toSession(row: SessionRow) {
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
    const [totals] = await pg.query<{
      max_connections: number;
      reserved: number;
      total: number;
      active: number;
      idle: number;
      idle_in_transaction: number;
      waiting_on_lock: number;
    }>(
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

    const usable = (totals?.max_connections ?? 0) - (totals?.reserved ?? 0);
    return {
      connections: {
        ...totals,
        used_pct: usable > 0 ? Math.round((100 * (totals?.total ?? 0)) / usable) : null,
        top_clients: byClient.map((c) => ({
          user: c.user_name,
          application: c.application_name || null,
          connections: c.n,
        })),
      },
      sessions: sessions.map(toSession),
    };
  },
});

export interface BlockingEdge {
  readonly pid: number;
  readonly blocked_by: readonly number[];
}

/**
 * From "who waits on whom" edges, finds the root blockers (blocking others, not waiting themselves)
 * and how many sessions each one holds up, directly or through a chain. Cycles (deadlocks that
 * Postgres has not resolved yet) produce no root.
 */
export function rootBlockers(edges: readonly BlockingEdge[]): Array<{ pid: number; blocks_total: number }> {
  const waiters = new Map<number, number[]>();
  for (const { pid, blocked_by } of edges) {
    for (const blocker of blocked_by) waiters.set(blocker, [...(waiters.get(blocker) ?? []), pid]);
  }
  const isWaiting = new Set(edges.filter((e) => e.blocked_by.length > 0).map((e) => e.pid));

  const countHeldUp = (root: number): number => {
    const seen = new Set<number>();
    const queue = [...(waiters.get(root) ?? [])];
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      if (pid === root || seen.has(pid)) continue;
      seen.add(pid);
      queue.push(...(waiters.get(pid) ?? []));
    }
    return seen.size;
  };

  return [...waiters.keys()]
    .filter((pid) => !isWaiting.has(pid))
    .map((pid) => ({ pid, blocks_total: countHeldUp(pid) }))
    .sort((a, b) => b.blocks_total - a.blocks_total);
}

const MAX_LISTED = 20;

export const pgBlocking = defineTool({
  name: "pg_blocking",
  level: Level.Read,
  requires: ["pg"],
  title: "Postgres: lock blocking chains",
  description:
    "Which sessions are stuck waiting on locks, and the root blockers holding them up. Each root blocker " +
    "comes with its state, transaction age and query, plus how many sessions it blocks directly or through " +
    "a chain. A root that is 'idle in transaction' is usually an application that opened a transaction and " +
    "never finished it; its query is the last statement it ran, not necessarily the one that took the lock. " +
    "pid 0 means a prepared transaction. Literals in query text are replaced with ?.",
  input: {},
  timeoutMs: 8_000,

  async run(_args, { pg }) {
    const rows = await pg.query<
      SessionRow & { lock_type: string | null; lock_mode: string | null; relation: string | null }
    >(
      `WITH waiting AS (
         SELECT pid, pg_blocking_pids(pid) AS blocked_by
           FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
       ), involved AS (
         SELECT pid FROM waiting WHERE cardinality(blocked_by) > 0
         UNION
         SELECT unnest(blocked_by) FROM waiting
       )
       SELECT ${SESSION_COLUMNS},
              l.locktype            AS lock_type,
              l.mode                AS lock_mode,
              l.relation::regclass::text AS relation
         FROM pg_stat_activity a
         JOIN involved i ON i.pid = a.pid
         LEFT JOIN LATERAL (
           SELECT locktype, mode, relation FROM pg_locks WHERE pid = a.pid AND NOT granted LIMIT 1
         ) l ON true
        WHERE a.pid <> pg_backend_pid()`,
    );

    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const waiting = rows.filter((r) => r.blocked_by.length > 0);
    const roots = rootBlockers(rows);

    return {
      waiting_sessions: waiting.length,
      root_blockers: roots.slice(0, MAX_LISTED).map(({ pid, blocks_total }) => {
        const row = byPid.get(pid);
        return {
          blocks_total,
          blocks_directly: waiting.filter((w) => w.blocked_by.includes(pid)).map((w) => w.pid),
          ...(row ? toSession(row) : { pid, note: "not visible in pg_stat_activity" }),
        };
      }),
      waiting: waiting
        .toSorted((a, b) => (b.state_age_s ?? 0) - (a.state_age_s ?? 0))
        .slice(0, MAX_LISTED)
        .map((w) => ({
          ...toSession(w),
          waiting_for: { lock_type: w.lock_type, mode: w.lock_mode, relation: w.relation },
        })),
    };
  },
});
