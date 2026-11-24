import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { assertNotWriteServer, serverEnv, WRITE_SERVER_NAME } from "../../src/mcp.js";
import { createReporter } from "../../src/report.js";

const DEFAULTS = { server: "/app/mcp-server/dist/src/index.js" };

describe("loadConfig", () => {
  it("defaults to Haiku, a check a minute and a small investigation budget", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "sk-test" }, DEFAULTS);
    expect(config).toMatchObject({
      model: "claude-haiku-5-5",
      intervalMs: 60_000,
      maxCostUsd: 0.05,
      server: DEFAULTS.server,
      namespaces: [],
      reportFile: undefined,
      policy: { ignore: [], resolveAfterChecks: 3, maxPerHour: 3, maxPerDay: 10 },
    });
  });

  it("reads the ignore list and the namespaces as comma-separated lists", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-test",
      OPS_WATCH_IGNORE: "no maxmemory limit, ",
      OPS_K8S_NAMESPACES: "app,jobs",
    };
    const config = loadConfig(env, DEFAULTS);
    expect(config.policy.ignore).toEqual(["no maxmemory limit"]);
    expect(config.namespaces).toEqual(["app", "jobs"]);
  });

  it("refuses to start without an API key or with a check more often than every 10 seconds", () => {
    expect(() => loadConfig({}, DEFAULTS)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test", OPS_WATCH_INTERVAL_S: "5" }, DEFAULTS)).toThrow();
  });
});

describe("serverEnv", () => {
  it("passes the server its own settings, never the API key or the watcher's settings", () => {
    const env = serverEnv({
      ANTHROPIC_API_KEY: "sk-ant-planted-4471",
      OPS_PG_URL: "postgres://ops_ro:pw@db/app",
      OPS_K8S_NAMESPACES: "app",
      OPS_WATCH_REPORT_FILE: "/var/lib/ops-watcher/reports.jsonl",
      KUBERNETES_SERVICE_HOST: "10.43.0.1",
    });
    expect(env).toMatchObject({
      OPS_PG_URL: "postgres://ops_ro:pw@db/app",
      OPS_K8S_NAMESPACES: "app",
      KUBERNETES_SERVICE_HOST: "10.43.0.1",
    });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPS_WATCH_REPORT_FILE");
    expect(JSON.stringify(env)).not.toContain("sk-ant-planted-4471");
  });
});

describe("createReporter", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("logs each report and appends it to the file as one JSON line", async () => {
    dir = await mkdtemp(join(tmpdir(), "ops-watcher-"));
    const file = join(dir, "reports.jsonl");
    const logged: string[] = [];
    const report = createReporter({ file, log: (line) => logged.push(line) });

    await report({ at: "2026-11-23T12:00:00.000Z", event: "check_failed", error: "MCP connection closed" });
    await report({ at: "2026-11-23T12:01:00.000Z", event: "incident_resolved", incident: 1, findings: ["a: b"] });

    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toEqual(logged);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["check_failed", "incident_resolved"]);
  });
});

describe("assertNotWriteServer", () => {
  it("refuses the write server, which trusts its client to put each approval in front of a human", () => {
    expect(() => assertNotWriteServer({ name: WRITE_SERVER_NAME, version: "0.1.0" })).toThrow(/write server/);
  });

  it("accepts the read server, and a server that does not name itself", () => {
    expect(() => assertNotWriteServer({ name: "ops", version: "0.1.0" })).not.toThrow();
    expect(() => assertNotWriteServer(undefined)).not.toThrow();
  });
});
