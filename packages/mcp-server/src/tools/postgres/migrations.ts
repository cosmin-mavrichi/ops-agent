import { describeSpan } from "../../lib/units.js";
import type { SqlClient } from "../../types.js";

/** One entry in the database's timeline of changes; times are seconds ago, from the database's own clock. */
export interface DbChange {
  readonly at_ago_s: number;
  readonly kind: "restart" | "config_reload" | "analyze" | "migration";
  readonly object: string;
  readonly change: string;
}

export interface Findings {
  readonly changes: readonly DbChange[];
  readonly problems: readonly string[];
}

// A Prisma migration that failed stays unfinished, and `prisma migrate deploy` refuses to run until it is resolved.
// A running one looks the same, so only one this old counts as stuck.
const UNFINISHED_AFTER_S = 600;
const MAX_ROWS = 50;
// Schema-per-tenant setups can have one history table per schema.
const MAX_TABLES = 10;

const notGranted = (schema: string, table: string) =>
  `${schema}.${table}: ops_ro may not read it; run deploy/sql/ops_ro_migrations.sql` +
  (schema === "public" ? "" : ` with the schema changed to ${schema}`);

// Names are written by developers, but are text from the database all the same: one line, no control characters.
const oneLine = (name: string) => name.replace(/\p{Cc}+/gu, " ");

/**
 * A migration tool's history table, by its default name. Only name and time columns are granted and read: never
 * Prisma's `logs`, which holds a failed migration's error output and can quote data.
 */
interface Source {
  readonly table: string;
  readonly columns: readonly string[];
  read(pg: SqlClient, table: string): Promise<Findings>;
}

const migration = (name: string, atAgoS: number, change: string): DbChange => ({
  at_ago_s: atAgoS,
  kind: "migration",
  object: `migration ${oneLine(name)}`,
  change,
});

interface PrismaRow extends Record<string, unknown> {
  readonly name: string;
  readonly started_ago_s: number;
  readonly took_s: number | null;
  readonly rolled_back: boolean;
}

function prismaOutcome(row: PrismaRow): { readonly outcome: string; readonly stuck: boolean } {
  if (row.rolled_back) return { outcome: "marked rolled back (prisma migrate resolve)", stuck: false };
  if (row.took_s !== null) return { outcome: `applied in ${describeSpan(row.took_s)}`, stuck: false };
  if (row.started_ago_s < UNFINISHED_AFTER_S) {
    return { outcome: `running for ${describeSpan(row.started_ago_s)}`, stuck: false };
  }
  const outcome =
    `started ${describeSpan(row.started_ago_s)} ago and never finished: it failed, or still runs ` +
    "(prisma migrate deploy refuses to run until it is resolved)";
  return { outcome, stuck: true };
}

const prisma: Source = {
  table: "_prisma_migrations",
  columns: ["migration_name", "started_at", "finished_at", "rolled_back_at"],
  async read(pg, table) {
    const rows = await pg.query<PrismaRow>(`
SELECT left(migration_name, 200)                                  AS name,
       round(extract(epoch FROM now() - started_at))::int         AS started_ago_s,
       round(extract(epoch FROM finished_at - started_at))::int   AS took_s,
       rolled_back_at IS NOT NULL                                 AS rolled_back
  FROM ${table}
 ORDER BY finished_at IS NULL AND rolled_back_at IS NULL DESC, started_at DESC
 LIMIT ${MAX_ROWS}`);
    const read = rows.map((row) => ({ row, ...prismaOutcome(row) }));
    const changes = read.map(({ row, outcome }) => migration(row.name, row.started_ago_s, `prisma: ${outcome}`));
    const problems = read
      .filter(({ stuck }) => stuck)
      .map(({ row, outcome }) => `migration ${oneLine(row.name)}: ${outcome}`);
    return { changes, problems };
  },
};

interface KnexRow extends Record<string, unknown> {
  readonly name: string;
  readonly batch: number;
  readonly at_ago_s: number;
}

const knex: Source = {
  table: "knex_migrations",
  columns: ["name", "batch", "migration_time"],
  async read(pg, table) {
    const rows = await pg.query<KnexRow>(`
SELECT left(name, 200)                                         AS name,
       batch,
       round(extract(epoch FROM now() - migration_time))::int  AS at_ago_s
  FROM ${table}
 ORDER BY migration_time DESC
 LIMIT ${MAX_ROWS}`);
    const changes = rows.map((row) => migration(row.name, row.at_ago_s, `knex: applied (batch ${row.batch})`));
    return { changes, problems: [] };
  },
};

// Inside a transaction (knex's default) the lock is never visible to other sessions; a lock that is visible was
// taken without one, and is either held by a migration running now or left by one that crashed.
const KNEX_LOCKED =
  "the knex migration lock is held: a migration is running now, or one crashed and left it, and every later " +
  "`knex migrate:latest` fails with 'Migration table is already locked' until `knex migrate:unlock`";

const knexLock: Source = {
  table: "knex_migrations_lock",
  columns: ["is_locked"],
  async read(pg, table) {
    const [row] = await pg.query<{ locked: number }>(
      `SELECT count(*) FILTER (WHERE is_locked = 1)::int AS locked FROM ${table}`,
    );
    const locked = (row?.locked ?? 0) > 0;
    return { changes: [], problems: locked ? [KNEX_LOCKED] : [] };
  },
};

interface KyselyRow extends Record<string, unknown> {
  readonly name: string;
  readonly at_ago_s: number | null;
}

// Kysely stores when a migration ran as ISO text; the cast is guarded so one bad row cannot fail the query.
const kysely: Source = {
  table: "kysely_migration",
  columns: ["name", "timestamp"],
  async read(pg, table) {
    const rows = await pg.query<KyselyRow>(`
SELECT left(name, 200) AS name,
       CASE WHEN "timestamp" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
            THEN round(extract(epoch FROM now() - "timestamp"::timestamptz))::int
       END AS at_ago_s
  FROM ${table}
 ORDER BY "timestamp" DESC
 LIMIT ${MAX_ROWS}`);
    const dated = rows.flatMap((row) => (row.at_ago_s === null ? [] : [{ ...row, at_ago_s: row.at_ago_s }]));
    return { changes: dated.map((row) => migration(row.name, row.at_ago_s, "kysely: applied")), problems: [] };
  },
};

const SOURCES: readonly Source[] = [prisma, knex, knexLock, kysely];

export interface FoundTable extends Record<string, unknown> {
  readonly schema: string;
  readonly table: string;
  readonly usable: boolean;
  readonly readable_columns: readonly string[];
}

const FIND_SQL = `
SELECT n.nspname                           AS schema,
       c.relname                           AS table,
       has_schema_privilege(n.oid, 'USAGE') AS usable,
       array(SELECT a.attname::text
               FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                AND has_column_privilege(c.oid, a.attnum, 'SELECT')) AS readable_columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
 ORDER BY n.nspname, c.relname
 LIMIT ${MAX_TABLES}`;

/** Names come from the catalog, not from the caller, but are quoted all the same: identifiers cannot be bound. */
const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

const sourceOf = (found: FoundTable) => SOURCES.find((source) => source.table === found.table);

function isReadable(found: FoundTable, source: Source): boolean {
  return found.usable && source.columns.every((column) => found.readable_columns.includes(column));
}

export interface MigrationFindings extends Findings {
  /** History tables found but not granted to ops_ro. */
  readonly unreadable: readonly string[];
}

/** Every migration history table in the database that ops_ro may read; the rest are named, not read. */
export async function readMigrations(pg: SqlClient): Promise<MigrationFindings> {
  const found = await pg.query<FoundTable>(FIND_SQL, [SOURCES.map((source) => source.table)]);
  const tables = found.flatMap((table) => {
    const source = sourceOf(table);
    return source ? [{ table, source }] : [];
  });
  const readable = tables.filter(({ table, source }) => isReadable(table, source));
  const unreadable = tables
    .filter(({ table, source }) => !isReadable(table, source))
    .map(({ table }) => notGranted(table.schema, table.table));
  const read = await Promise.all(
    readable.map(({ table, source }) => source.read(pg, `${quoteIdent(table.schema)}.${quoteIdent(table.table)}`)),
  );
  return {
    changes: read.flatMap((findings) => findings.changes),
    problems: read.flatMap((findings) => findings.problems),
    unreadable,
  };
}
