import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createK8sClient } from "./adapters/k8s.js";
import { createPgClient } from "./adapters/pg.js";
import { createRedisClient } from "./adapters/redis.js";
import { type K8sSettings, loadConfig } from "./config.js";
import { createRedactor } from "./lib/redact.js";
import { type RegistryOptions, registerTools } from "./registry.js";
import { allTools, toolsFor } from "./tools/index.js";
import type { Adapter, K8sClient, RedisClient } from "./types.js";

const cfg = loadConfig();

const redact = createRedactor(cfg.knownSecrets);
// stdout is the MCP channel — all logging goes to stderr.
const log = (msg: string, meta?: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...meta })}\n`);
const pg = createPgClient({
  connectionString: cfg.pgUrl,
  onError: (err) => log("pg_pool_error", { error: redact(err.message) }),
});

const k8s = cfg.k8s ? k8sClientFrom(cfg.k8s) : k8sNotConfigured();
const redis = cfg.redisUrl ? redisClientFrom(cfg.redisUrl) : redisNotConfigured();
const tools = toolsFor(allTools, configuredAdapters());

const registryOpts: RegistryOptions = {
  maxLevel: cfg.maxLevel,
  redact,
  context: (signal) => ({ pg, k8s, redis, signal, log }),
  audit: (e) => log("tool_call", { ...e }),
};

// serveStdio calls this once per connection and pins the instance for that connection,
// serving both the 2025-era protocol and the 2026-07-28 revision from the same tools.
const handle = serveStdio(
  () => {
    const server = new McpServer({ name: "ops", version: "0.1.0" }, { capabilities: { tools: {} } });
    const exposed = registerTools(server, tools, registryOpts);
    log("session", { tools: exposed });
    return server;
  },
  { onerror: (err) => log("mcp_error", { error: err.message }) },
);
log("ready");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await handle.close();
    await pg.end();
    process.exit(0);
  });
}

function k8sClientFrom(settings: K8sSettings): K8sClient {
  return createK8sClient({
    server: settings.server,
    ca: readFileSync(settings.caFile, "utf8"),
    token: () => readFileSync(settings.tokenFile, "utf8").trim(),
    namespaces: settings.namespaces,
  });
}

function redisClientFrom(url: string): RedisClient {
  return createRedisClient({ url, onError: (err) => log("redis_error", { error: redact(err.message) }) });
}

function configuredAdapters(): Adapter[] {
  const adapters: Adapter[] = ["pg"];
  if (cfg.k8s) adapters.push("k8s");
  if (cfg.redisUrl) adapters.push("redis");
  return adapters;
}

// Never called: tools for an adapter that isn't configured are not exposed (see toolsFor).
function notConfigured(adapter: string) {
  return async (): Promise<never> => {
    throw new Error(`${adapter} is not configured`);
  };
}

function k8sNotConfigured(): K8sClient {
  return { namespaces: [], getJson: notConfigured("kubernetes"), getText: notConfigured("kubernetes") };
}

function redisNotConfigured(): RedisClient {
  return { send: notConfigured("redis") };
}
