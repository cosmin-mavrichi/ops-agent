import knexFactory, { type Knex } from "knex";

/** Runs knex's real migrator with the given migrations, as an application's `knex migrate:latest` would. */
/** knex refuses a migration without both functions; for migrations whose content does not matter. */
export const EMPTY_MIGRATION: Knex.Migration = { up: async () => {}, down: async () => {} };

export async function runKnexMigrations(url: string, migrations: Readonly<Record<string, Knex.Migration>>) {
  const knex = knexFactory({
    client: "pg",
    connection: url,
    migrations: {
      migrationSource: {
        getMigrations: async () => Object.keys(migrations),
        getMigrationName: (name: string) => name,
        getMigration: async (name: string) => migrations[name] ?? EMPTY_MIGRATION,
      },
    },
  });
  try {
    await knex.migrate.latest();
  } finally {
    await knex.destroy();
  }
}
