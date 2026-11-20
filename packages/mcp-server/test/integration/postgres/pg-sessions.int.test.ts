import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgClient } from "../../../src/adapters/pg.js";
import { pgActivity } from "../../../src/tools/postgres/activity.js";
import { pgBlocking } from "../../../src/tools/postgres/blocking.js";
import { startHarness } from "../../harness.js";
import { APP_NAME, OPS_PW, type PgFixture, startPostgres } from "./pg-fixture.js";

const PLANTED = "tok-planted-in-live-query-5531";

let db: PgFixture;
let opsPg: ReturnType<typeof createPgClient>;
let h: Awaited<ReturnType<typeof startHarness>>;
let holder: pg.Client;
let waiters: pg.Client[];
let pending: Array<Promise<unknown>>;
let holderPid: number;
let lockTablePid: number;

async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

beforeAll(async () => {
  db = await startPostgres();
  await db.admin.query("CREATE TABLE orders (id int PRIMARY KEY, note text)");
  await db.admin.query("INSERT INTO orders VALUES (1, 'new')");

  // The incident: a transaction left open after a write, and two sessions queued behind it.
  holder = await db.connectApp();
  holderPid = await backendPid(holder);
  await holder.query("BEGIN");
  await holder.query(`UPDATE orders SET note = '${PLANTED}' WHERE id = 1`);

  const updater = await db.connectApp();
  const locker = await db.connectApp();
  waiters = [updater, locker];
  lockTablePid = await backendPid(locker);
  pending = [
    updater.query("UPDATE orders SET note = 'second' WHERE id = 1"),
    locker.query("BEGIN; LOCK TABLE orders IN ACCESS EXCLUSIVE MODE"),
  ].map((p) => p.catch(() => undefined));

  await vi.waitFor(
    async () => {
      const { rows } = await db.admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      expect(rows[0].n).toBe(2);
    },
    { timeout: 5_000, interval: 100 },
  );

  opsPg = createPgClient({ connectionString: db.opsUrl, onError: () => {} });
  h = await startHarness({ tools: [pgActivity, pgBlocking], pg: opsPg, knownSecrets: [OPS_PW] });
}, 120_000);

afterAll(async () => {
  // Releasing the holder lets the queue reorder (LOCK TABLE can win and then block the UPDATE),
  // so end all app sessions at once instead of unwinding them in order.
  await db?.terminateApp();
  await Promise.all(pending ?? []);
  await Promise.all([holder, ...(waiters ?? [])].map((c) => c?.end().catch(() => undefined)));
  await h?.close();
  await opsPg?.end();
  await db?.stop();
});

describe("pg_blocking against real Postgres", () => {
  it("names the open transaction as the root blocker of the whole chain", async () => {
    const res = await h.call("pg_blocking");
    expect(res.isError).toBe(false);
    expect(res.json.waiting_sessions).toBe(2);
    expect(res.json.root_blockers).toHaveLength(1);
    expect(res.json.root_blockers[0]).toMatchObject({
      pid: holderPid,
      state: "idle in transaction",
      application: APP_NAME,
      blocks_total: 2,
    });
  });

  it("says what each waiter is waiting for", async () => {
    const res = await h.call("pg_blocking");
    const lockTable = res.json.waiting.find((w: { pid: number }) => w.pid === lockTablePid);
    expect(lockTable.waiting_for).toMatchObject({ mode: "AccessExclusiveLock", relation: "orders" });
  });

  it("never returns the literal from the blocker's last statement", async () => {
    const res = await h.call("pg_blocking");
    expect(res.text).toContain("UPDATE orders SET note = ? WHERE id = ?");
    expect(res.text).not.toContain(PLANTED);
  });
});

describe("pg_activity against real Postgres", () => {
  it("counts the stuck sessions and lists the oldest transaction first", async () => {
    const res = await h.call("pg_activity");
    expect(res.isError).toBe(false);
    expect(res.json.connections).toMatchObject({ idle_in_transaction: 1, waiting_on_lock: 2 });
    expect(res.json.connections.max_connections).toBeGreaterThan(0);
    expect(res.json.sessions[0]).toMatchObject({ pid: holderPid, state: "idle in transaction" });
    expect(res.text).not.toContain(PLANTED);
  });

  it("filters out sessions younger than min_age_s", async () => {
    const res = await h.call("pg_activity", { min_age_s: 3_600 });
    expect(res.json.sessions).toEqual([]);
  });
});
