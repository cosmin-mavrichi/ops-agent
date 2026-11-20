import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createK8sClient } from "./adapters/k8s.js";
import { createPgClient } from "./adapters/pg.js";
import { loadConfig } from "./config.js";
import { createRedactor } from "./lib/redact.js";
import { type RegistryOptions, registerTools } from "./registry.js";
import { allTools, toolsFor } from "./tools/index.js";
import type { Adapter, K8sClient } from "./types.js";

const cfg = loadConfig();
const redact = createRedactor(cfg.knownSecrets);
// stdout is the MCP channel — all logging goes to stderr.
const log = (msg: string, meta?: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...meta })}\n`);
const pg = createPgClient({
  connectionString: cfg.pgUrl,
  onError: (err) => log("pg_pool_error", { error: redact(err.message) }),
});

const k8sNotConfigured = async (): Promise<never> => {
  throw new Error("kubernetes is not configured");
};
const k8s: K8sClient = cfg.k8s
  ? createK8sClient({
      server: cfg.k8s.server,
      ca: readFileSync(cfg.k8s.caFile, "utf8"),
      token: () => readFileSync(cfg.k8s?.tokenFile ?? "", "utf8").trim(),
      namespaces: cfg.k8s.namespaces,
    })
  : { namespaces: [], getJson: k8sNotConfigured, getText: k8sNotConfigured };

const configured: Adapter[] = cfg.k8s ? ["pg", "k8s"] : ["pg"];
const tools = toolsFor(allTools, configured);

const registryOpts: RegistryOptions = {
  maxLevel: cfg.maxLevel,
  redact,
  context: (signal) => ({ pg, k8s, signal, log }),
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
