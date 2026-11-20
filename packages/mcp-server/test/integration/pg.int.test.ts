/**
 * Integration: real Postgres 16 in a throwaway container (Testcontainers).
 * Random port, fresh data, removed afterwards — nothing shared with your machine or other runs.
 * Requires Docker. Run: pnpm test:int
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgClient } from "../../src/adapters/pg.js";
import { pgSlowQueries } from "../../src/tools/postgres.js";
import { defineTool, Level } from "../../src/types.js";
import { startHarness } from "../harness.js";

const OPS_PW = "ops-ro-test-pw-9271";

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let opsPg: ReturnType<typeof createPgClient>;
let h: Awaited<ReturnType<typeof startHarness>>;
let opsUrl: string;
const poolErrors: Error[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("app")
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_stat_statements",
      "-c",
      "pg_stat_statements.track=top",
      "-c",
      "pg_stat_statements.track_utility=on", // on deliberately: proves redaction catches PASSWORD literals
    ])
    .start();

  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();

  // Same setup as deploy/sql/ops_ro.sql
  await admin.query("CREATE EXTENSION pg_stat_statements");
  await admin.query(`CREATE ROLE ops_ro LOGIN PASSWORD '${OPS_PW}' CONNECTION LIMIT 3`);
  await admin.query("GRANT pg_monitor TO ops_ro");
  await admin.query("ALTER ROLE ops_ro SET default_transaction_read_only = on");

  // Fixture workload: one table, a slow statement, a chatty statement, and a secret-bearing utility statement.
  await admin.query("CREATE TABLE reviews (id serial primary key, product_id int, body text)");
  await admin.query(
    "INSERT INTO reviews (product_id, body) SELECT g % 100, md5(g::text) FROM generate_series(1, 20000) g",
  );
  await admin.query("SELECT pg_stat_statements_reset()");
  for (let i = 0; i < 3; i++) await admin.query("SELECT pg_sleep(0.2), count(*) FROM reviews");
  for (let i = 0; i < 200; i++) await admin.query("SELECT body FROM reviews WHERE product_id = $1", [i % 100]);
  // Plant the secret on a separate role: altering ops_ro itself would change the password we connect with.
  await admin.query("CREATE ROLE app_user LOGIN");
  await admin.query("ALTER ROLE app_user PASSWORD 'leaked-in-stats-1234'");

  const url = new URL(container.getConnectionUri());
  url.username = "ops_ro";
  url.password = OPS_PW;
  opsUrl = url.toString();
  opsPg = createPgClient({ connectionString: opsUrl, onError: (err) => poolErrors.push(err) });
  h = await startHarness({ tools: [pgSlowQueries], pg: opsPg, knownSecrets: [OPS_PW] });
}, 120_000);

afterAll(async () => {
  await h?.close();
  await opsPg?.end();
  await admin?.end();
  await container?.stop();
});

describe("pg_slow_queries against real Postgres", () => {
  it("finds the individually slow statement by mean_time", async () => {
    const res = await h.call("pg_slow_queries", { order_by: "mean_time", limit: 3 });
    expect(res.isError).toBe(false);
    expect(res.json.queries[0].query).toContain("pg_sleep");
    expect(res.json.queries[0].mean_ms).toBeGreaterThan(150);
  });

  it("finds the chatty statement by calls, normalized with $1", async () => {
    const res = await h.call("pg_slow_queries", { order_by: "calls", limit: 3 });
    const top = res.json.queries[0];
    expect(top.calls).toBeGreaterThanOrEqual(200);
    expect(top.query).toContain("product_id = $1");
  });

  it("never returns the password from the ALTER ROLE statement", async () => {
    const res = await h.call("pg_slow_queries", { order_by: "calls", limit: 20 });
    expect(res.isError).toBe(false); // an error result would make the leak check vacuous
    expect(res.text).toContain("ALTER ROLE"); // the statement is in the output, only its literal is redacted
    expect(res.text).not.toContain("leaked-in-stats-1234");
  });
});

describe("ops_ro role is actually read-only", () => {
  it("cannot write", async () => {
    await expect(opsPg.query("CREATE TABLE x (id int)")).rejects.toThrow(/read-only transaction/);
  });

  it("cannot read application data", async () => {
    await expect(opsPg.query("SELECT body FROM reviews LIMIT 1")).rejects.toThrow(/permission denied/);
  });

  // The session flag is user-settable, so the real guarantee is privileges: this must fail on permissions.
  it("still cannot write after switching the read-only session flag off", async () => {
    // Own connection, separate statements: in one multi-statement query the implicit transaction has
    // already started read-only, so the CREATE would be stopped by the flag, not by privileges.
    const c = new pg.Client({ connectionString: opsUrl });
    await c.connect();
    try {
      await c.query("SET default_transaction_read_only = off");
      await expect(c.query("CREATE TABLE y (id int)")).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});

describe("adapter under failure", () => {
  it("times out a hung query on time, and Postgres ends it within statement_timeout", async () => {
    const sleepy = defineTool({
      name: "sleepy",
      level: Level.Read,
      title: "sleepy",
      description: "test",
      input: {},
      timeoutMs: 300,
      run: (_args, { pg }) => pg.query("SELECT pg_sleep(30)"),
    });
    const th = await startHarness({ tools: [sleepy], pg: opsPg });
    try {
      const started = Date.now();
      const res = await th.call("sleepy");
      expect(res.json.error).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_000);
      await expect(opsPg.query("SELECT 1 AS ok")).resolves.toEqual([{ ok: 1 }]);

      const stillRunning = () =>
        admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(30)' AND state = 'active'",
        );
      await vi.waitFor(async () => expect((await stillRunning()).rows[0].n).toBe(0), { timeout: 8_000, interval: 250 });
    } finally {
      await th.close();
    }
  }, 15_000);

  it("survives Postgres killing its idle connections", async () => {
    await opsPg.query("SELECT 1");
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'ops-mcp'");

    await vi.waitFor(() => expect(poolErrors.length).toBeGreaterThan(0));
    await expect(opsPg.query("SELECT 1 AS ok")).resolves.toEqual([{ ok: 1 }]);
  });
});
