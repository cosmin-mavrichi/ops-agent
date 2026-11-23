import { describe, expect, it } from "vitest";
import { pgJobQueues, type QueueRow, summarizeQueue } from "../../../src/tools/postgres/job-queues.js";
import type { SqlClient } from "../../../src/types.js";
import { useHarness } from "../../harness.js";

const harness = useHarness();

const queueRow = (overrides: Partial<QueueRow>): QueueRow => ({
  name: "emails",
  policy: "standard",
  dead_letter: null,
  ready_count: 0,
  deferred_count: 0,
  active_count: 0,
  failed_count: 0,
  queued_count: 0,
  warning_queued: 0,
  created_delta: 0,
  completed_delta: 0,
  failed_delta: 0,
  delta_seconds: 60,
  ready_oldest_seconds: 0,
  counted_ago_s: 20,
  ...overrides,
});

// exports has nobody working it; webhooks is worked but mostly failing; emails is fine.
const STALLED = queueRow({ name: "exports", ready_count: 1200, queued_count: 1200, ready_oldest_seconds: 5400 });
const FAILING = queueRow({ name: "webhooks", active_count: 2, completed_delta: 3, failed_delta: 40 });
const HEALTHY = queueRow({ name: "emails", active_count: 1, completed_delta: 90, created_delta: 88 });

/** Fake that answers the access check and the queue query, and records what was sent. */
function fakePg(opts: { access?: { readable: boolean } | null; rows?: QueueRow[] } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query<T>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("has_any_column_privilege")) {
        const access = opts.access === undefined ? { readable: true } : opts.access;
        return (access ? [access] : []) as T[];
      }
      return (opts.rows ?? [HEALTHY, STALLED, FAILING]) as T[];
    },
  };
  return { client, calls };
}

describe("summarizeQueue", () => {
  it("says nothing is working a queue with ready jobs, no active ones and no completions", () => {
    expect(summarizeQueue(STALLED, 600).problems).toEqual([
      "1200 jobs ready, none active and none completed in the last 1 minute: nothing is working this queue " +
        "(worker stopped, crashed or not subscribed)",
      "the oldest ready job has waited 1.5 hours",
    ]);
  });

  it("reports failures, and says when more fail than complete", () => {
    expect(summarizeQueue(FAILING, 600).problems).toEqual(["40 jobs failed in the last 1 minute, more than completed"]);
  });

  it('says "so far" before pg-boss has counted a first window, not "in the last 0 seconds"', () => {
    const fresh = { ...STALLED, delta_seconds: null, ready_oldest_seconds: null };
    expect(summarizeQueue(fresh, 600).problems[0]).toMatch(/^1200 jobs ready, none active and none completed so far: /);
  });

  it("finds nothing wrong with a queue that is being worked", () => {
    expect(summarizeQueue(HEALTHY, 600).problems).toEqual([]);
  });

  it("flags counts that nobody has refreshed for a while, or ever", () => {
    expect(summarizeQueue(queueRow({ counted_ago_s: 3600 }), 600).problems[0]).toContain("1 hour old");
    expect(summarizeQueue(queueRow({ counted_ago_s: null }), 600).problems).toEqual([
      "pg-boss has not counted this queue yet: no pg-boss instance has run its monitor",
    ]);
  });

  it("warns when the backlog is over the queue's own warning size", () => {
    const row = queueRow({ queued_count: 600, warning_queued: 500, active_count: 1, completed_delta: 5 });
    expect(summarizeQueue(row, 600).problems).toEqual(["600 jobs queued, over the queue's warning size of 500"]);
  });
});

describe("pg_job_queues (unit)", () => {
  it("puts the worst queues first", async () => {
    const h = await harness({ tools: [pgJobQueues], pg: fakePg().client });
    const res = await h.call("pg_job_queues");
    expect(res.isError, res.text).toBe(false);
    expect(res.json.queues.map((queue: { name: string }) => queue.name)).toEqual(["exports", "webhooks", "emails"]);
  });

  it("reads only pgboss.queue, never the job table, and binds the queue name", async () => {
    const pg = fakePg();
    const h = await harness({ tools: [pgJobQueues], pg: pg.client });
    await h.call("pg_job_queues", { queue: "exports'; DROP TABLE x; --" });
    const sql = pg.calls.map((call) => call.sql).join("\n");
    expect(sql).not.toMatch(/pgboss\.job\b/);
    expect(sql).not.toMatch(/\bdata\b|\boutput\b/);
    expect(pg.calls[1]?.params).toEqual(["exports'; DROP TABLE x; --"]);
  });

  it("says pg-boss is not installed instead of failing", async () => {
    const h = await harness({ tools: [pgJobQueues], pg: fakePg({ access: null }).client });
    const res = await h.call("pg_job_queues");
    expect(res.json).toMatchObject({ error: "unavailable" });
  });

  it("names the grant to run when ops_ro may not read the counters", async () => {
    const h = await harness({ tools: [pgJobQueues], pg: fakePg({ access: { readable: false } }).client });
    const res = await h.call("pg_job_queues");
    expect(res.json).toMatchObject({ error: "forbidden" });
    expect(res.json.message).toContain("deploy/sql/ops_ro_pgboss.sql");
  });
});
