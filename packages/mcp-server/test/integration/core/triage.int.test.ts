import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgClient } from "../../../src/adapters/pg.js";
import { createRedisClient } from "../../../src/adapters/redis.js";
import { opsTriage } from "../../../src/tools/triage.js";
import { startHarness } from "../../harness.js";
import { OPS_PW, type PgFixture, startPostgres } from "../postgres/pg-fixture.js";
import { OPS_REDIS_PW, type RedisFixture, startRedis } from "../redis/redis-fixture.js";

const PLANTED = "tok-planted-in-locked-row-8812";

let db: PgFixture;
let cache: RedisFixture;
let opsPg: ReturnType<typeof createPgClient>;
let h: Awaited<ReturnType<typeof startHarness>>;
let holder: pg.Client;
let waiter: Promise<unknown>;
let holderPid: number;

beforeAll(async () => {
  [db, cache] = await Promise.all([startPostgres(), startRedis("valkey")]);

  // Postgres: a transaction left open after a write, and a session queued behind it.
  await db.admin.query("CREATE TABLE orders (id int PRIMARY KEY, note text)");
  await db.admin.query("INSERT INTO orders VALUES (1, 'new')");
  holder = await db.connectApp();
  holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await holder.query("BEGIN");
  await holder.query(`UPDATE orders SET note = '${PLANTED}' WHERE id = 1`);
  const queued = await db.connectApp();
  waiter = queued.query("UPDATE orders SET note = 'second' WHERE id = 1").catch(() => undefined);
  await vi.waitFor(
    async () => {
      const { rows } = await db.admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      expect(rows[0].n).toBe(1);
    },
    { timeout: 5_000, interval: 100 },
  );

  // Valkey: a reporting client listing every key.
  await cache.admin.configSet({ "slowlog-log-slower-than": "0" });
  const reports = await cache.connectApp("reports");
  await reports.keys("order:*");

  opsPg = createPgClient({ connectionString: db.opsUrl, onError: () => {} });
  h = await startHarness({
    tools: [opsTriage],
    pg: opsPg,
    redis: createRedisClient({ url: cache.opsUrl, onError: () => {} }),
    knownSecrets: [OPS_PW, OPS_REDIS_PW],
  });
}, 180_000);

afterAll(async () => {
  await db?.terminateApp();
  await waiter;
  await holder?.end().catch(() => undefined);
  await h?.close();
  await opsPg?.end();
  await Promise.all([db?.stop(), cache?.stop()]);
});

describe("ops_triage against real Postgres and Valkey", () => {
  it("finds the lock wait and the whole-keyspace read in one call", async () => {
    const res = await h.call("ops_triage");
    expect(res.isError).toBe(false);
    expect(res.json.problems.pg_blocking).toEqual([`1 session waiting on locks; root blockers: pid ${holderPid}`]);
    expect(res.json.problems.redis_slowlog[0]).toContain("KEYS from reports");
  });

  it("checks only the configured services and says why pg_job_queues could not run", async () => {
    const res = await h.call("ops_triage");
    const checked = [...Object.keys(res.json.problems), ...res.json.clean, ...Object.keys(res.json.unavailable)];
    expect(checked.toSorted()).toEqual(["pg_blocking", "pg_job_queues", "redis_health", "redis_slowlog"]);
    expect(res.json.unavailable.pg_job_queues).toMatch(/pg-boss/);
  });

  it("never shows the locked row's data or the agent's own passwords", async () => {
    const res = await h.call("ops_triage");
    expect(res.text).not.toContain(PLANTED);
    expect(res.text).not.toContain(OPS_PW);
    expect(res.text).not.toContain(OPS_REDIS_PW);
  });
});
