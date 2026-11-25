import { readFileSync } from "node:fs";
import type { Knex } from "knex";
import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgClient } from "../../../src/adapters/pg.js";
import { pgChanges } from "../../../src/tools/postgres/changes.js";
import { opsTriage } from "../../../src/tools/triage.js";
import { type Harness, startHarness } from "../../harness.js";
import { runKnexMigrations } from "./migration-tools.js";
import { OPS_PW, type PgFixture, startPostgres } from "./pg-fixture.js";

const LOG_SECRET = "planted-migration-log-7730";
const ROLE_SECRET = "planted-role-setting-2291";
const ROW_SECRET = "planted-table-row-5108";
const GRANTS = readFileSync(new URL("../../../../../deploy/sql/ops_ro_migrations.sql", import.meta.url), "utf8");

// Prisma's own table, as its migration engine creates it (the engine is a native binary, not worth installing here).
const PRISMA_TABLE = `
CREATE TABLE _prisma_migrations (
  id                  VARCHAR(36) PRIMARY KEY NOT NULL,
  checksum            VARCHAR(64) NOT NULL,
  finished_at         TIMESTAMPTZ,
  migration_name      VARCHAR(255) NOT NULL,
  logs                TEXT,
  rolled_back_at      TIMESTAMPTZ,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
VALUES ('a1', 'c1', '20261124090000_add_index', now() - interval '5 minutes', now() - interval '299 seconds', 1);
INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, logs)
VALUES ('a2', 'c2', '20261124060000_backfill', now() - interval '3 hours', 'ERROR: duplicate key ${LOG_SECRET}');`;

let db: PgFixture;
let ops: ReturnType<typeof createPgClient>;
let h: Harness;

const ordersMigration: Knex.Migration = {
  async up(knex) {
    await knex.schema.createTable("orders", (table) => {
      table.increments();
      table.string("note");
    });
    await knex("orders").insert({ note: ROW_SECRET });
  },
  async down() {},
};

async function runKysely(url: string): Promise<void> {
  const app = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }) });
  const users = { up: (kdb: Kysely<unknown>) => kdb.schema.createTable("users").addColumn("id", "integer").execute() };
  const migrator = new Migrator({ db: app, provider: { getMigrations: async () => ({ "0001_users": users }) } });
  try {
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  } finally {
    await app.destroy();
  }
}

beforeAll(async () => {
  db = await startPostgres();
  const url = db.container.getConnectionUri();
  await db.admin.query(PRISMA_TABLE);
  await runKnexMigrations(url, { "20261124080000_orders": ordersMigration });
  await runKysely(url);
  await db.admin.query("UPDATE knex_migrations_lock SET is_locked = 1");
  await db.admin.query("ANALYZE orders");
  await db.admin.query("CREATE ROLE app_user LOGIN");
  await db.admin.query("ALTER ROLE app_user SET statement_timeout = '200ms'");
  await db.admin.query(`ALTER ROLE app_user SET app.api_key = '${ROLE_SECRET}'`);
  await db.admin.query("ALTER SYSTEM SET idle_in_transaction_session_timeout = '1s'");
  await db.admin.query("ALTER SYSTEM SET shared_buffers = '64MB'");
  // A reload within seconds of the start is not told apart from it: reload once the server has run a while.
  await db.admin.query("SELECT pg_sleep(greatest(0, 6 - extract(epoch FROM now() - pg_postmaster_start_time())))");
  await db.admin.query("SELECT pg_reload_conf()");
  ops = createPgClient({ connectionString: db.opsUrl, onError: () => {} });
  h = await startHarness({ tools: [pgChanges, opsTriage], pg: ops, knownSecrets: [OPS_PW] });
}, 120_000);

afterAll(async () => {
  await h?.close();
  await ops?.end();
  await db?.stop();
});

const changeOf = (changes: ReadonlyArray<{ object: string; change: string }>, object: string) =>
  changes.find((change) => change.object === object)?.change;

// In order: the grant is applied by the second test.
describe("pg_changes against Postgres 16, as ops_ro", () => {
  it("names the history tables it may not read yet, and still reports the server's changes", async () => {
    const { json, text } = await h.call("pg_changes");
    expect(json.unreadable).toEqual([
      expect.stringMatching(/^public\._prisma_migrations: ops_ro may not read it/),
      expect.stringMatching(/^public\.knex_migrations: /),
      expect.stringMatching(/^public\.knex_migrations_lock: /),
      expect.stringMatching(/^public\.kysely_migration: /),
    ]);
    expect(json.changes.map((change: { kind: string }) => change.kind)).toEqual(
      expect.arrayContaining(["restart", "config_reload", "analyze"]),
    );
    expect(changeOf(json.changes, "table public.orders")).toMatch(/^ANALYZE run by hand/);
    expect(json.settings).toContain("idle_in_transaction_session_timeout = 1s (ALTER SYSTEM)");
    expect(json.role_settings).toEqual(["statement_timeout=200ms for app_user in every database"]);
    expect(json.pending_restart).toEqual(["shared_buffers"]);
    expect(text).not.toContain(ROLE_SECRET);
  });

  it("reads each tool's migrations once granted, and reports the stuck ones", async () => {
    await db.admin.query(GRANTS);
    const { json, text } = await h.call("pg_changes");
    expect(json.unreadable).toEqual([]);
    expect(changeOf(json.changes, "migration 20261124090000_add_index")).toBe("prisma: applied in 1 second");
    expect(changeOf(json.changes, "migration 20261124080000_orders")).toBe("knex: applied (batch 1)");
    expect(changeOf(json.changes, "migration 0001_users")).toBe("kysely: applied");
    expect(json.problems).toEqual([
      expect.stringMatching(/^migration 20261124060000_backfill: started 3 hours ago and never finished/),
      expect.stringContaining("Migration table is already locked"),
    ]);
    for (const secret of [LOG_SECRET, ROLE_SECRET, ROW_SECRET]) expect(text).not.toContain(secret);
  });

  it("puts the stuck migrations in ops_triage", async () => {
    const { json } = await h.call("ops_triage");
    expect(json.problems.pg_changes).toHaveLength(2);
  });
});
