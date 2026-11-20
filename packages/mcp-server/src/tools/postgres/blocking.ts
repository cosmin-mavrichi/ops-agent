import { defineTool, Level } from "../../types.js";
import { SESSION_COLUMNS, type SessionRow, toSession } from "./shared.js";

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
  const waitersOf = directWaiters(edges);
  const isWaiting = new Set(edges.filter((edge) => edge.blocked_by.length > 0).map((edge) => edge.pid));
  const blockers = [...waitersOf.keys()];

  return blockers
    .filter((pid) => !isWaiting.has(pid))
    .map((pid) => ({ pid, blocks_total: collectHeldUp(pid, waitersOf).size }))
    .sort((a, b) => b.blocks_total - a.blocks_total);
}

/** Blocker pid → pids waiting on it directly. */
function directWaiters(edges: readonly BlockingEdge[]): Map<number, number[]> {
  const waitersOf = new Map<number, number[]>();
  for (const { pid, blocked_by } of edges) {
    for (const blocker of blocked_by) {
      const waiters = waitersOf.get(blocker) ?? [];
      waitersOf.set(blocker, [...waiters, pid]);
    }
  }
  return waitersOf;
}

/** Every pid waiting on `pid`, directly or through a chain. Already-seen pids are skipped, so cycles end. */
function collectHeldUp(pid: number, waitersOf: ReadonlyMap<number, number[]>, heldUp = new Set<number>()): Set<number> {
  for (const waiter of waitersOf.get(pid) ?? []) {
    if (heldUp.has(waiter)) continue;
    heldUp.add(waiter);
    collectHeldUp(waiter, waitersOf, heldUp);
  }
  return heldUp;
}

const MAX_LISTED = 20;

interface BlockingRow extends SessionRow {
  lock_type: string | null;
  lock_mode: string | null;
  relation: string | null;
}

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
    const rows = await pg.query<BlockingRow>(
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

    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const waiting = rows.filter((row) => row.blocked_by.length > 0);

    const describeRoot = ({ pid, blocks_total }: { pid: number; blocks_total: number }) => {
      const row = byPid.get(pid);
      // pid 0 (a prepared transaction) or a session that ended between the two views.
      const session = row ? toSession(row) : { pid, note: "not visible in pg_stat_activity" };
      const blocksDirectly = waiting.filter((w) => w.blocked_by.includes(pid)).map((w) => w.pid);
      return { blocks_total, blocks_directly: blocksDirectly, ...session };
    };

    const describeWaiter = (row: BlockingRow) => ({
      ...toSession(row),
      waiting_for: { lock_type: row.lock_type, mode: row.lock_mode, relation: row.relation },
    });

    const longestWaitingFirst = (a: BlockingRow, b: BlockingRow) => (b.state_age_s ?? 0) - (a.state_age_s ?? 0);

    return {
      waiting_sessions: waiting.length,
      root_blockers: rootBlockers(rows).slice(0, MAX_LISTED).map(describeRoot),
      waiting: waiting.toSorted(longestWaitingFirst).slice(0, MAX_LISTED).map(describeWaiter),
    };
  },
});
