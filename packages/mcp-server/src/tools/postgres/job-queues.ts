import { z } from "zod";
import { describeSpan } from "../../lib/units.js";
import { defineTool, Level, type SqlClient, ToolError } from "../../types.js";

// pg-boss refreshes these counts every 60s by default (monitorIntervalSeconds) in any running instance.
const STALE_AFTER_S = 300;

const NOT_INSTALLED =
  "No pg-boss queue table (pgboss.queue) in this database: the application does not use pg-boss, or uses " +
  "another schema name.";
const NOT_GRANTED =
  "pg-boss is installed, but ops_ro may not read its queue counters. Run deploy/sql/ops_ro_pgboss.sql once.";

/**
 * Only pgboss.queue, the counters pg-boss keeps for its own monitoring. Never pgboss.job: it holds each
 * job's payload (data) and result or error (output). ops_ro is granted these columns only.
 */
const QUEUE_SQL = `
SELECT name,
       policy,
       dead_letter,
       ready_count,
       deferred_count,
       active_count,
       failed_count,
       queued_count,
       warning_queued,
       created_delta,
       completed_delta,
       failed_delta,
       delta_seconds,
       ready_oldest_seconds,
       round(extract(epoch FROM now() - monitor_on))::int AS counted_ago_s
  FROM pgboss.queue
 WHERE $1::text IS NULL OR name = $1
 ORDER BY name`;

const ACCESS_SQL = `
SELECT has_schema_privilege(n.oid, 'USAGE') AND has_any_column_privilege(c.oid, 'SELECT') AS readable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'pgboss' AND c.relname = 'queue'`;

export interface QueueRow extends Record<string, unknown> {
  readonly name: string;
  readonly policy: string;
  readonly dead_letter: string | null;
  readonly ready_count: number;
  readonly deferred_count: number;
  readonly active_count: number;
  readonly failed_count: number;
  readonly queued_count: number;
  readonly warning_queued: number;
  readonly created_delta: number;
  readonly completed_delta: number;
  readonly failed_delta: number;
  readonly delta_seconds: number | null;
  readonly ready_oldest_seconds: number | null;
  readonly counted_ago_s: number | null;
}

const NEVER_COUNTED = "pg-boss has not counted this queue yet: no pg-boss instance has run its monitor";

function problemsOf(row: QueueRow, maxWaitS: number): string[] {
  if (row.counted_ago_s === null) return [NEVER_COUNTED];

  const problems: string[] = [];
  // Before pg-boss has counted a first window there is none: "so far", not "in the last 0 seconds".
  const window = row.delta_seconds === null ? "so far" : `in the last ${describeSpan(row.delta_seconds)}`;
  if (row.counted_ago_s > STALE_AFTER_S) {
    problems.push(
      `these counts are ${describeSpan(row.counted_ago_s)} old: no pg-boss instance is refreshing them ` +
        "(are all workers and producers down?)",
    );
  }
  const idle = row.active_count === 0 && row.completed_delta === 0;
  if (row.ready_count > 0 && idle) {
    problems.push(
      `${row.ready_count} jobs ready, none active and none completed ${window}: ` +
        "nothing is working this queue (worker stopped, crashed or not subscribed)",
    );
  }
  if (row.ready_oldest_seconds !== null && row.ready_oldest_seconds >= maxWaitS) {
    problems.push(`the oldest ready job has waited ${describeSpan(row.ready_oldest_seconds)}`);
  }
  if (row.warning_queued > 0 && row.queued_count >= row.warning_queued) {
    problems.push(`${row.queued_count} jobs queued, over the queue's warning size of ${row.warning_queued}`);
  }
  if (row.failed_delta > 0) {
    const ratio = row.failed_delta > row.completed_delta ? ", more than completed" : "";
    problems.push(`${row.failed_delta} jobs failed ${window}${ratio}`);
  }
  return problems;
}

export function summarizeQueue(row: QueueRow, maxWaitS: number) {
  return {
    name: row.name,
    policy: row.policy,
    ready: row.ready_count,
    deferred: row.deferred_count,
    active: row.active_count,
    failed: row.failed_count,
    oldest_ready_wait_s: row.ready_oldest_seconds,
    last_window: {
      seconds: row.delta_seconds,
      created: row.created_delta,
      completed: row.completed_delta,
      failed: row.failed_delta,
    },
    dead_letter: row.dead_letter,
    counted_ago_s: row.counted_ago_s,
    problems: problemsOf(row, maxWaitS),
  };
}

type Queue = ReturnType<typeof summarizeQueue>;
const byUrgency = (a: Queue, b: Queue) => b.problems.length - a.problems.length || b.ready - a.ready;

async function assertReadable(pg: SqlClient): Promise<void> {
  const [access] = await pg.query<{ readable: boolean }>(ACCESS_SQL);
  if (access === undefined) throw new ToolError("not_installed", NOT_INSTALLED);
  if (!access.readable) throw new ToolError("forbidden", NOT_GRANTED);
}

export const pgJobQueues = defineTool({
  name: "pg_job_queues",
  level: Level.Read,
  requires: ["pg"],
  title: "Postgres: pg-boss job queues",
  description:
    "Backlog of each pg-boss job queue in the application database, from pg-boss's own counters: jobs ready, " +
    "scheduled for later, active and failed, how long the oldest ready job has waited, and what was created, " +
    "completed and failed in the last monitor window. Lists problems (nothing working a queue, long waits, " +
    "failures, stale counts) with the worst queues first. Use it when background work (emails, exports, " +
    "webhooks) is late or missing. Never returns job payloads.",
  input: {
    queue: z.string().min(1).max(200).optional(),
    max_wait_s: z.number().int().min(1).max(86_400).default(600),
    limit: z.number().int().min(1).max(200).default(25),
  },
  timeoutMs: 8_000,

  async run({ queue, max_wait_s, limit }, { pg }) {
    await assertReadable(pg);
    const rows = await pg.query<QueueRow>(QUEUE_SQL, [queue ?? null]);
    const queues = rows.map((row) => summarizeQueue(row, max_wait_s)).toSorted(byUrgency);
    return { total: queues.length, queues: queues.slice(0, limit) };
  },
});
