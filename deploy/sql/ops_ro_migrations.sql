-- Optional: lets pg_changes read when schema migrations ran, from the history tables of Prisma, knex and Kysely
-- in the "public" schema (edit the schema below if your tool uses another). Run once as the database owner, after
-- ops_ro.sql and after the application has run its first migration; a table that does not exist yet is skipped.
-- Usage: psql "$ADMIN_URL" -f ops_ro_migrations.sql
--
-- Only name and time columns. Never Prisma's "logs" (a failed migration's error output, which can quote data) or
-- its checksums. Drizzle is not covered: its table records when a migration was generated, not when it ran.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    GRANT SELECT (migration_name, started_at, finished_at, rolled_back_at) ON public._prisma_migrations TO ops_ro;
  END IF;
  IF to_regclass('public.knex_migrations') IS NOT NULL THEN
    GRANT SELECT (name, batch, migration_time) ON public.knex_migrations TO ops_ro;
  END IF;
  IF to_regclass('public.knex_migrations_lock') IS NOT NULL THEN
    GRANT SELECT (is_locked) ON public.knex_migrations_lock TO ops_ro;
  END IF;
  IF to_regclass('public.kysely_migration') IS NOT NULL THEN
    GRANT SELECT (name, "timestamp") ON public.kysely_migration TO ops_ro;
  END IF;
END
$$;
