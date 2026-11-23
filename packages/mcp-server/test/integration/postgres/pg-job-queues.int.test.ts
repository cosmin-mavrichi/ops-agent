import { readFileSync } from "node:fs";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgClient } from "../../../src/adapters/pg.js";
import { pgJobQueues } from "../../../src/tools/postgres/job-queues.js";
import { type Harness, startHarness } from "../../harness.js";
import { OPS_PW, type PgFixture, startPostgres } from "./pg-fixture.js";

const PAYLOAD_SECRET = "planted-job-payload-6204";
const ERROR_SECRET = "planted-job-error-3381";
const GRANTS = readFileSync(new URL("../../../../../deploy/sql/ops_ro_pgboss.sql", import.meta.url), "utf8");

type Queue = { name: string; ready: number; failed: number; problems: string[] };
const findQueue = (json: { queues: Queue[] }, name: string) => json.queues.find((queue) => queue.name === name);

let db: PgFixture;
let ops: ReturnType<typeof createPgClient>;
let h: Harness;
let boss: PgBoss;

beforeAll(async () => {
  db = await startPostgres();
  ops = createPgClient({ connectionString: db.opsUrl, onError: () => {} });
  h = await startHarness({ tools: [pgJobQueues], pg: ops, knownSecrets: [OPS_PW] });
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false, timeout: 1_000 });
  await h?.close();
  await ops?.end();
  await db?.stop();
});

/** The application: pg-boss counting every second, a worker for emails, a failing one for webhooks, none for exports. */
async function startApplication(): Promise<PgBoss> {
  const app = new PgBoss({
    connectionString: db.container.getConnectionUri(),
    monitorIntervalSeconds: 1,
    superviseIntervalSeconds: 1,
  });
  app.on("error", () => {});
  await app.start();
  await app.createQueue("emails");
  await app.createQueue("exports");
  await app.createQueue("webhooks", { retryLimit: 0 });
  await app.work("emails", { pollingIntervalSeconds: 0.5 }, async () => {});
  await app.work("webhooks", { pollingIntervalSeconds: 0.5 }, async () => {
    throw new Error(`delivery refused, token ${ERROR_SECRET}`);
  });
  for (let i = 0; i < 5; i++) {
    await app.send("exports", { customer: "c-42", apiKey: PAYLOAD_SECRET });
    await app.send("emails", { to: "someone@example.com" });
    await app.send("webhooks", { url: "https://hooks.example.com", secret: PAYLOAD_SECRET });
  }
  return app;
}

// In order: pg-boss is installed by the second test, and the grant applied by the third.
describe("pg_job_queues against pg-boss", () => {
  it("says pg-boss is not installed in a database without it", async () => {
    const res = await h.call("pg_job_queues");
    expect(res.json).toMatchObject({ error: "not_installed" });
  });

  it("names the grant to run when ops_ro may not read the counters yet", async () => {
    boss = await startApplication();
    const res = await h.call("pg_job_queues");
    expect(res.json).toMatchObject({ error: "forbidden" });
  }, 60_000);

  it("shows the unworked queue and the failing one from pg-boss's own counters", async () => {
    await db.admin.query(GRANTS);
    await vi.waitFor(
      async () => {
        const res = await h.call("pg_job_queues");
        expect(res.isError, res.text).toBe(false);
        expect(findQueue(res.json, "exports")?.ready).toBe(5);
        expect(findQueue(res.json, "webhooks")?.failed).toBe(5);
      },
      { timeout: 30_000, interval: 1_000 },
    );

    const res = await h.call("pg_job_queues");
    expect(res.json.queues[0].name).toBe("exports");
    expect(findQueue(res.json, "exports")?.problems.join("\n")).toContain("nothing is working this queue");
    expect(findQueue(res.json, "emails")?.problems).toEqual([]);
  }, 60_000);

  it("never returns payloads or job errors, and ops_ro cannot read them directly", async () => {
    const res = await h.call("pg_job_queues");
    expect(res.text).not.toContain(PAYLOAD_SECRET);
    expect(res.text).not.toContain(ERROR_SECRET);

    const direct = new pg.Client({ connectionString: db.opsUrl });
    await direct.connect();
    try {
      await expect(direct.query("SELECT data, output FROM pgboss.job")).rejects.toThrow(/permission denied/);
      await expect(direct.query("SELECT singletons_active FROM pgboss.queue")).rejects.toThrow(/permission denied/);
    } finally {
      await direct.end();
    }
  });
});
