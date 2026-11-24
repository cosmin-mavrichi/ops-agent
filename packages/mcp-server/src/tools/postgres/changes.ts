import { z } from "zod";
import { MINUTE_S } from "../../lib/units.js";
import { defineTool, Level, type SqlClient } from "../../types.js";
import { type DbChange, readMigrations } from "./migrations.js";

/**
 * Settings that change how the application's queries behave or how many can connect. Only these are read: a
 * setting's value can hold a secret (primary_conninfo, a custom app.* setting set per role).
 */
export const WATCHED_SETTINGS = [
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "idle_session_timeout",
  "transaction_timeout",
  "deadlock_timeout",
  "max_connections",
  "superuser_reserved_connections",
  "max_locks_per_transaction",
  "shared_buffers",
  "work_mem",
  "maintenance_work_mem",
  "effective_cache_size",
  "random_page_cost",
  "max_parallel_workers_per_gather",
  "jit",
  "plan_cache_mode",
  "default_transaction_isolation",
  "default_transaction_read_only",
  "synchronous_commit",
  "search_path",
] as const;

// A session started before a reload re-reads the files a moment later; closer than this to the start is no reload.
const RELOAD_SKEW_S = 5;
const MAX_ANALYZED = 20;
const MAX_CHANGES = 50;

interface ServerRow extends Record<string, unknown> {
  readonly started_ago_s: number;
  readonly reloaded_ago_s: number;
  readonly pending_restart: readonly string[];
}

const SERVER_SQL = `
SELECT round(extract(epoch FROM now() - pg_postmaster_start_time()))::int AS started_ago_s,
       round(extract(epoch FROM now() - pg_conf_load_time()))::int        AS reloaded_ago_s,
       array(SELECT name::text FROM pg_settings WHERE pending_restart ORDER BY name) AS pending_restart`;

interface SettingRow extends Record<string, unknown> {
  readonly name: string;
  readonly value: string;
  readonly source: string;
}

// Only values that come from the server's files: this tool's own session sets statement_timeout, lock_timeout and
// default_transaction_read_only, so their server-wide values are not visible here.
const SETTINGS_SQL = `
SELECT name,
       current_setting(name) AS value,
       CASE WHEN sourcefile LIKE '%postgresql.auto.conf' THEN 'ALTER SYSTEM' ELSE 'config file' END AS source
  FROM pg_settings
 WHERE name = ANY($1::text[]) AND source = 'configuration file'
 ORDER BY name`;

interface RoleSettingRow extends Record<string, unknown> {
  readonly role: string;
  readonly database: string;
  readonly setting: string;
}

// ALTER ROLE/DATABASE ... SET, apart from ops_ro's own (deploy/sql/ops_ro.sql).
const ROLE_SETTINGS_SQL = `
SELECT coalesce(r.rolname::text, 'every role')     AS role,
       coalesce(d.datname::text, 'every database') AS database,
       config                                       AS setting
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole
  LEFT JOIN pg_database d ON d.oid = s.setdatabase
 CROSS JOIN unnest(s.setconfig) AS config
 WHERE split_part(config, '=', 1) = ANY($1::text[])
   AND s.setrole IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname = current_user)
 ORDER BY 1, 2, 3`;

interface AnalyzedRow extends Record<string, unknown> {
  readonly table_name: string;
  readonly at_ago_s: number;
}

// Manual runs only: autoanalyze runs all day on a busy database, while ANALYZE by hand or in a migration is a change.
const ANALYZED_SQL = `
SELECT schemaname || '.' || relname                          AS table_name,
       round(extract(epoch FROM now() - last_analyze))::int  AS at_ago_s
  FROM pg_stat_user_tables
 WHERE last_analyze >= now() - make_interval(mins => $1)
 ORDER BY last_analyze DESC
 LIMIT ${MAX_ANALYZED}`;

export function serverChanges(server: ServerRow): readonly DbChange[] {
  const restart: DbChange = {
    at_ago_s: server.started_ago_s,
    kind: "restart",
    object: "postgres",
    change: "server started (a restart, failover or new instance): every connection was dropped",
  };
  const reloaded = server.reloaded_ago_s < server.started_ago_s - RELOAD_SKEW_S;
  if (!reloaded) return [restart];
  const reload: DbChange = {
    at_ago_s: server.reloaded_ago_s,
    kind: "config_reload",
    object: "postgres",
    change: "configuration reloaded (pg_reload_conf or SIGHUP): changed settings took effect, see settings",
  };
  return [restart, reload];
}

const analyzeChange = (row: AnalyzedRow): DbChange => ({
  at_ago_s: row.at_ago_s,
  kind: "analyze",
  object: `table ${row.table_name}`,
  change: "ANALYZE run by hand or by a migration: new planner statistics, so query plans may have changed",
});

const describeSetting = (row: SettingRow) => `${row.name} = ${row.value} (${row.source})`;
const describeRoleSetting = (row: RoleSettingRow) => `${row.setting} for ${row.role} in ${row.database}`;

async function readServer(pg: SqlClient) {
  const watched = [...WATCHED_SETTINGS];
  const [[server], settings, roleSettings] = await Promise.all([
    pg.query<ServerRow>(SERVER_SQL),
    pg.query<SettingRow>(SETTINGS_SQL, [watched]),
    pg.query<RoleSettingRow>(ROLE_SETTINGS_SQL, [watched]),
  ]);
  if (server === undefined) throw new Error("the server query returned no row");
  return { server, settings: settings.map(describeSetting), roleSettings: roleSettings.map(describeRoleSetting) };
}

const newestFirst = (a: DbChange, b: DbChange) => a.at_ago_s - b.at_ago_s;

export const pgChanges = defineTool({
  name: "pg_changes",
  level: Level.Read,
  requires: ["pg"],
  title: "Postgres: what changed",
  description:
    "What changed in the database, newest first: when Postgres last started (a restart drops every connection) " +
    "or reloaded its configuration, ANALYZE run by hand, and schema migrations from the Prisma, knex and Kysely " +
    "history tables (when each ran; a Prisma one that never finished). Also the current values of settings that " +
    "change how queries behave (timeouts, memory, connections) when set in the config file, by ALTER SYSTEM or " +
    "per role or database, and settings waiting for a restart. Most incidents start right after a change: " +
    "compare `at_ago_s` with when the trouble began. A change close in time is a lead, not proof.",
  input: {
    since_minutes: z.number().int().min(1).max(10_080).default(1_440),
  },
  timeoutMs: 8_000,

  async run({ since_minutes }, { pg }) {
    const [{ server, settings, roleSettings }, analyzed, migrations] = await Promise.all([
      readServer(pg),
      pg.query<AnalyzedRow>(ANALYZED_SQL, [since_minutes]),
      readMigrations(pg),
    ]);
    const windowS = since_minutes * MINUTE_S;
    const all = [...serverChanges(server), ...analyzed.map(analyzeChange), ...migrations.changes];
    const changes = all.filter((change) => change.at_ago_s <= windowS).toSorted(newestFirst);
    return {
      total: changes.length,
      changes: changes.slice(0, MAX_CHANGES),
      settings,
      role_settings: roleSettings,
      pending_restart: server.pending_restart,
      problems: migrations.problems,
      unreadable: migrations.unreadable,
    };
  },
});
