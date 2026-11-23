import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { connectServer, serverEnv } from "./mcp.js";
import { createReporter } from "./report.js";
import { watch } from "./watch.js";

// The server built next to the watcher, as in the repo and the image: packages/{watcher,mcp-server}/dist/src.
const BUNDLED_SERVER = fileURLToPath(new URL("../../../mcp-server/dist/src/index.js", import.meta.url));

const config = loadConfig(process.env, { server: BUNDLED_SERVER });
if (config.reportFile) await mkdir(dirname(config.reportFile), { recursive: true });
const report = createReporter({ file: config.reportFile, log: (line) => process.stderr.write(`${line}\n`) });

const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());

// Without its server the watcher sees nothing: exit, so Kubernetes restarts the pod instead of it idling.
const onServerClosed = () => {
  if (stop.signal.aborted) return;
  process.stderr.write("the MCP server exited; stopping\n");
  process.exit(1);
};
const server = await connectServer(config.server, serverEnv(process.env), onServerClosed);
const client = new Anthropic({ apiKey: config.apiKey });

await watch(
  {
    triage: server.triage,
    investigate: ({ symptom, context }) =>
      runAgent({
        client,
        model: config.model,
        tools: server.tools,
        symptom,
        context,
        maxTurns: config.maxTurns,
        maxCostUsd: config.maxCostUsd,
      }),
    report,
    now: () => new Date(),
  },
  { policy: config.policy, intervalMs: config.intervalMs, namespaces: config.namespaces, signal: stop.signal },
);
await server.close();
