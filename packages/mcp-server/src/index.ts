import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPgClient } from "./adapters/pg.js";
import { loadConfig } from "./config.js";
import { createRedactor } from "./lib/redact.js";
import { registerTools, type RegistryOptions } from "./registry.js";
import { allTools } from "./tools/index.js";

const cfg = loadConfig();
const redact = createRedactor(cfg.knownSecrets);
// stdout is the MCP channel — all logging goes to stderr.
const log = (msg: string, meta?: Record<string, unknown>) =>
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), msg, ...meta }) + "\n");
const pg = createPgClient({
  connectionString: cfg.pgUrl,
  onError: (err) => log("pg_pool_error", { error: redact(err.message) }),
});

const registryOpts: RegistryOptions = {
  maxLevel: cfg.maxLevel,
  redact,
  context: (signal) => ({ pg, signal, log }),
  audit: (e) => log("tool_call", { ...e }),
};

// serveStdio calls this once per connection and pins the instance for that connection,
// serving both the 2025-era protocol and the 2026-07-28 revision from the same tools.
const handle = serveStdio(
  () => {
    const server = new McpServer({ name: "ops", version: "0.1.0" }, { capabilities: { tools: {} } });
    const exposed = registerTools(server, allTools, registryOpts);
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
