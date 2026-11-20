import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

export const OPS_PW = "ops-ro-test-pw-9271";
export const APP_NAME = "app-test";

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  /** Superuser connection for seeding and inspecting. */
  admin: pg.Client;
  /** Connection string for the ops_ro role, set up as in deploy/sql/ops_ro.sql. */
  opsUrl: string;
  /** A new superuser client, for simulating application sessions. */
  connectApp(): Promise<pg.Client>;
  /** Kills every session opened with connectApp, whatever state its locks are in. */
  terminateApp(): Promise<void>;
  stop(): Promise<void>;
}

/** Postgres 16 in a throwaway container with pg_stat_statements and the ops_ro role. */
export async function startPostgres(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
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

  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query("CREATE EXTENSION pg_stat_statements");
  await admin.query(`CREATE ROLE ops_ro LOGIN PASSWORD '${OPS_PW}' CONNECTION LIMIT 3`);
  await admin.query("GRANT pg_monitor TO ops_ro");
  await admin.query("ALTER ROLE ops_ro SET default_transaction_read_only = on");

  const url = new URL(container.getConnectionUri());
  url.username = "ops_ro";
  url.password = OPS_PW;

  return {
    container,
    admin,
    opsUrl: url.toString(),
    async connectApp() {
      const client = new pg.Client({ connectionString: container.getConnectionUri(), application_name: APP_NAME });
      client.on("error", () => {}); // expected when terminateApp kills the session
      await client.connect();
      return client;
    },
    async terminateApp() {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [
        APP_NAME,
      ]);
    },
    async stop() {
      await admin.end();
      await container.stop();
    },
  };
}
