import { describe, expect, it } from "vitest";
import { pgActivity, pgBlocking, rootBlockers } from "../../../src/tools/postgres/sessions.js";
import type { SqlClient } from "../../../src/types.js";
import { useHarness } from "../../harness.js";

const PLANTED = "tok-planted-9911";

function session(pid: number, overrides: Record<string, unknown> = {}) {
  return {
    pid,
    database: "app",
    user_name: "app",
    application_name: "api",
    client_addr: "10.0.0.7",
    backend_type: "client backend",
    state: "active",
    wait_event_type: null,
    wait_event: null,
    xact_age_s: 12,
    query_age_s: 12,
    state_age_s: 12,
    blocked_by: [],
    query: "SELECT 1",
    ...overrides,
  };
}

/** Answers by matching on the statement; records every call. */
function fakePg(answers: { totals?: object; clients?: object[]; sessions?: object[]; blocking?: object[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("max_connections")) return [answers.totals ?? {}] as never;
      if (sql.includes("GROUP BY")) return (answers.clients ?? []) as never;
      if (sql.includes("WITH waiting")) return (answers.blocking ?? []) as never;
      return (answers.sessions ?? []) as never;
    },
  };
  return { client, calls };
}

const harness = useHarness();

describe("pg_activity (unit)", () => {
  const totals = { max_connections: 100, reserved: 3, total: 90, active: 20, idle: 60, idle_in_transaction: 10 };

  it("reports connection usage against the usable limit", async () => {
    const pg = fakePg({ totals, clients: [{ user_name: "worker", application_name: "", n: 70 }] });
    const h = await harness({ tools: [pgActivity], pg: pg.client });
    const res = await h.call("pg_activity");
    expect(res.isError).toBe(false);
    expect(res.json.connections).toMatchObject({ total: 90, used_pct: 93 });
    expect(res.json.connections.top_clients).toEqual([{ user: "worker", application: null, connections: 70 }]);
  });

  it("passes filters as bound parameters", async () => {
    const pg = fakePg({ totals });
    const h = await harness({ tools: [pgActivity], pg: pg.client });
    await h.call("pg_activity", { min_age_s: 30, limit: 5 });
    expect(pg.calls.at(-1)?.params).toEqual([30, 5]);
  });

  it("strips literals from live query text", async () => {
    const query = `UPDATE users SET nickname = '${PLANTED}' WHERE id = 4471`;
    const pg = fakePg({ totals, sessions: [session(7, { state: "idle in transaction", query })] });
    const h = await harness({ tools: [pgActivity], pg: pg.client });
    const res = await h.call("pg_activity");
    expect(res.json.sessions[0].query).toBe("UPDATE users SET nickname = ? WHERE id = ?");
    expect(res.text).not.toContain(PLANTED);
  });

  it("rejects out-of-range filters", async () => {
    const h = await harness({ tools: [pgActivity], pg: fakePg({ totals }).client });
    expect((await h.call("pg_activity", { limit: 500 })).isError).toBe(true);
    expect((await h.call("pg_activity", { min_age_s: -1 })).isError).toBe(true);
  });
});

describe("rootBlockers", () => {
  it("finds the root of a chain and counts everyone it holds up", () => {
    // 1 blocks 2 and 3; 3 blocks 4
    const edges = [
      { pid: 1, blocked_by: [] },
      { pid: 2, blocked_by: [1] },
      { pid: 3, blocked_by: [1] },
      { pid: 4, blocked_by: [3] },
    ];
    expect(rootBlockers(edges)).toEqual([{ pid: 1, blocks_total: 3 }]);
  });

  it("orders independent roots by impact", () => {
    const edges = [
      { pid: 2, blocked_by: [1] },
      { pid: 4, blocked_by: [3] },
      { pid: 5, blocked_by: [3] },
    ];
    expect(rootBlockers(edges)).toEqual([
      { pid: 3, blocks_total: 2 },
      { pid: 1, blocks_total: 1 },
    ]);
  });

  it("treats a blocker missing from the rows (pid 0, prepared transaction) as a root", () => {
    expect(rootBlockers([{ pid: 2, blocked_by: [0] }])).toEqual([{ pid: 0, blocks_total: 1 }]);
  });

  it("returns no root for a pure cycle, and terminates", () => {
    const edges = [
      { pid: 1, blocked_by: [2] },
      { pid: 2, blocked_by: [1] },
    ];
    expect(rootBlockers(edges)).toEqual([]);
  });

  it("returns nothing when nobody waits", () => {
    expect(rootBlockers([{ pid: 1, blocked_by: [] }])).toEqual([]);
  });
});

describe("pg_blocking (unit)", () => {
  it("names the idle-in-transaction root blocker and what waits on it", async () => {
    const pg = fakePg({
      blocking: [
        session(10, { state: "idle in transaction", xact_age_s: 600, query: `UPDATE orders SET note = '${PLANTED}'` }),
        session(11, { wait_event_type: "Lock", wait_event: "transactionid", blocked_by: [10], lock_mode: "ShareLock" }),
        session(12, { wait_event_type: "Lock", wait_event: "relation", blocked_by: [11], relation: "orders" }),
      ],
    });
    const h = await harness({ tools: [pgBlocking], pg: pg.client });
    const res = await h.call("pg_blocking");

    expect(res.isError).toBe(false);
    expect(res.json.waiting_sessions).toBe(2);
    expect(res.json.root_blockers).toHaveLength(1);
    expect(res.json.root_blockers[0]).toMatchObject({
      pid: 10,
      state: "idle in transaction",
      transaction_age_s: 600,
      blocks_total: 2,
      blocks_directly: [11],
    });
    expect(res.json.waiting.map((w: { pid: number }) => w.pid).sort()).toEqual([11, 12]);
    expect(res.text).not.toContain(PLANTED);
  });

  it("reports a quiet database plainly", async () => {
    const h = await harness({ tools: [pgBlocking], pg: fakePg({ blocking: [] }).client });
    expect((await h.call("pg_blocking")).json).toEqual({ waiting_sessions: 0, root_blockers: [], waiting: [] });
  });

  it("takes no arguments", async () => {
    const h = await harness({ tools: [pgBlocking], pg: fakePg({}).client });
    expect((await h.call("pg_blocking", { pid: 1 })).isError).toBe(true);
  });
});
