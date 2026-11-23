import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type PgFixture, startPostgres } from "../../../mcp-server/test/integration/postgres/pg-fixture.js";
import { runAgent } from "../../src/agent.js";
import { initialState, type Policy } from "../../src/incidents.js";
import { connectServer, type Server, serverEnv } from "../../src/mcp.js";
import { createReporter } from "../../src/report.js";
import { check, type WatchDeps } from "../../src/watch.js";

const SERVER_PACKAGE = fileURLToPath(new URL("../../../mcp-server", import.meta.url));
const SERVER_ENTRY = join(SERVER_PACKAGE, "dist/src/index.js");
const API_KEY = "sk-ant-planted-never-for-the-server-5517";
const POLICY: Policy = { ignore: [], resolveAfterChecks: 1, maxPerHour: 5, maxPerDay: 20 };

/** A model that answers at once and records what it was sent: the watcher's wiring is under test, not the model. */
function fakeModel() {
  const requests: Anthropic.MessageCreateParams[] = [];
  const answer = {
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: "Root cause: an open transaction holds the orders row lock." }],
  };
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        requests.push(structuredClone(params));
        return answer;
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

let db: PgFixture;
let holder: Awaited<ReturnType<PgFixture["connectApp"]>>;
let waiter: Promise<unknown>;
let server: Server;
let dir: string;

beforeAll(async () => {
  // The watcher runs the real built server, as in production.
  execFileSync("pnpm", ["--filter", "@ops-agent/mcp-server", "build"], { stdio: "inherit" });
  db = await startPostgres();
  await db.admin.query("CREATE TABLE orders (id int PRIMARY KEY, note text)");
  await db.admin.query("INSERT INTO orders VALUES (1, 'new')");
  holder = await db.connectApp();
  await holder.query("BEGIN");
  await holder.query("UPDATE orders SET note = 'held' WHERE id = 1");
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

  const env = serverEnv({ ...process.env, OPS_PG_URL: db.opsUrl, ANTHROPIC_API_KEY: API_KEY });
  server = await connectServer(SERVER_ENTRY, env, () => {});
  dir = await mkdtemp(join(tmpdir(), "ops-watcher-int-"));
}, 180_000);

afterAll(async () => {
  await server?.close();
  await db?.terminateApp();
  await waiter;
  await holder?.end().catch(() => undefined);
  await db?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the watcher against the real MCP server and Postgres", () => {
  it("investigates the lock wait once, with the evidence in the first message, and reports it resolved later", async () => {
    const model = fakeModel();
    const file = join(dir, "reports.jsonl");
    const deps: WatchDeps = {
      triage: server.triage,
      investigate: ({ symptom, context }) =>
        runAgent({
          client: model.client,
          model: "claude-haiku-5-5",
          tools: server.tools,
          symptom,
          context,
          maxTurns: 5,
          maxCostUsd: 0.05,
        }),
      report: createReporter({ file, log: () => {} }),
      now: () => new Date(),
    };

    const open = await check(initialState, deps, POLICY, []);
    const stillOpen = await check(open, deps, POLICY, []);
    await db.terminateApp();
    await vi.waitFor(async () => {
      const { rows } = await db.admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      expect(rows[0].n).toBe(0);
    });
    await check(stillOpen, deps, POLICY, []);

    const reports = (await readFile(file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(reports.map((report) => report.event)).toEqual(["incident", "incident_resolved"]);
    expect(reports[0]).toMatchObject({
      incident: 1,
      findings: [expect.stringMatching(/^pg_blocking: 1 session waiting on locks; root blockers: pid \d+$/)],
      outcome: "answered",
      report: "Root cause: an open transaction holds the orders row lock.",
    });

    expect(model.requests).toHaveLength(1);
    const first = JSON.stringify(model.requests[0]?.messages[0]);
    expect(first).toContain("The watcher found new problems");
    expect(first).toContain("waiting on locks");
    const toolNames = (model.requests[0]?.tools ?? []).map((tool) => ("name" in tool ? tool.name : undefined));
    expect(toolNames).toContain("ops_triage");
  });

  it("never gives the server the model's API key", () => {
    const env = serverEnv({ ...process.env, OPS_PG_URL: db.opsUrl, ANTHROPIC_API_KEY: API_KEY });
    expect(JSON.stringify(env)).not.toContain(API_KEY);
  });
});
