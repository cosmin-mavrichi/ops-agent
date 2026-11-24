import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequestStateCodec } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRedactor, readSecretsDir } from "@ops-agent/mcp-server/shared";
import { createK8sWriteClient } from "./adapters/k8s-write.js";
import { APPROVAL_TTL_S, createApprovals } from "./approval.js";
import { loadConfig } from "./config.js";
import { createExclusive } from "./exclusive.js";
import { createWriteServer } from "./server.js";
import { writeTools } from "./tools/index.js";
import { ROLLOUT_TIMING } from "./tools/k8s/rollout-check.js";

const cfg = loadConfig();

// stdout is the MCP channel — all logging goes to stderr.
const log = (msg: string, meta?: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...meta })}\n`);
const readToken = () => readFileSync(cfg.k8s.tokenFile, "utf8").trim();
// The write token is a secret of this server's own: if any output or form ever carries it, it is scrubbed. Only the
// token at boot is known verbatim; one swapped in later is still a JWT, which the redactor's patterns catch.
const redact = createRedactor([...cfg.knownSecrets, ...secretsFromDir(), readToken()]);
const k8s = createK8sWriteClient({
  server: cfg.k8s.server,
  ca: readFileSync(cfg.k8s.caFile, "utf8"),
  token: readToken,
  namespaces: cfg.k8s.namespaces,
});

// A key per process: one stdio process serves both rounds of every approval, and a restart voids open forms.
const codec = createRequestStateCodec({ key: randomBytes(32), ttlSeconds: APPROVAL_TTL_S });
const approvals = createApprovals(codec);
const exclusive = createExclusive();

const handle = serveStdio(
  () => {
    const { server, exposed } = createWriteServer({
      tools: writeTools,
      verifyState: codec.verify,
      registry: {
        maxLevel: cfg.maxLevel,
        redact,
        context: (signal, round) => ({
          k8s,
          approvals,
          exclusive,
          round,
          signal,
          log,
          now: () => new Date(),
          rollout: ROLLOUT_TIMING,
          redact,
        }),
        audit: (entry) => log("tool_call", { ...entry }),
      },
    });
    log("session", { tools: exposed });
    return server;
  },
  { onerror: (err) => log("mcp_error", { error: redact(err.message) }) },
);
log("ready");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await handle.close();
    process.exit(0);
  });
}

/** App secrets mounted for redaction only; nothing else may read them, and they are never logged. */
function secretsFromDir(): string[] {
  if (!cfg.knownSecretsDir) return [];
  return readSecretsDir(cfg.knownSecretsDir, (message) => log("known_secrets_warning", { message }));
}
