import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ElicitResult, type Tool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseJson } from "../test/harness.js";
import type { K3sFixture } from "../test/integration/k8s/k8s-fixture.js";

const WRITE_RBAC = readFileSync(new URL("../../../deploy/k8s/ops-write.yaml", import.meta.url), "utf8");
/** Built by `pnpm lab` and `pnpm eval` before the run: the write server as production runs it. */
const WRITE_SERVER_ENTRY = fileURLToPath(new URL("../../mcp-write/dist/src/index.js", import.meta.url));
// Above the restart's own 4-minute limit, so a slow rollout ends as the tool's result, not a client timeout.
const CALL_TIMEOUT_MS = 300_000;

/** How the human at the client answers every approval form: in the lab and evals, code answers on the test's say. */
export type FormAnswer = "approve" | "decline";

const ANSWERS: Readonly<Record<FormAnswer, ElicitResult>> = {
  approve: { action: "accept", content: { approve: true } },
  decline: { action: "decline" },
};

export interface WriteToolResult {
  readonly isError: boolean;
  readonly text: string;
  // Parsed like the read harness's results, so evidence checks read both the same way.
  readonly json: ReturnType<typeof parseJson>;
}

export interface WriteServer {
  readonly tools: readonly Tool[];
  /** Every approval form the server showed, as the human would read it. */
  readonly forms: readonly string[];
  call(name: string, args: Record<string, unknown>): Promise<WriteToolResult>;
  close(): Promise<void>;
}

export interface WriteServerOptions {
  /** A private temp dir for the token file; the caller removes it. */
  readonly dir: string;
  readonly caFile: string;
  readonly answer: FormAnswer;
  readonly knownSecrets: readonly string[];
}

/**
 * The write server (packages/mcp-write) as a child process over stdio, with the real ops-write RBAC and a
 * short-lived token made for the session, as docs/v2-design.md runs it next to a human.
 */
export async function startWriteServer(k3s: K3sFixture, options: WriteServerOptions): Promise<WriteServer> {
  await k3s.apply(WRITE_RBAC);
  const token = await k3s.kubectl("create", "token", "ops-write", "-n", "ops", "--duration=1h");
  const tokenFile = join(options.dir, "write-token");
  writeFileSync(tokenFile, token);
  const env = {
    ...getDefaultEnvironment(),
    OPS_K8S_NAMESPACES: k3s.ops.namespaces.join(","),
    OPS_K8S_SERVER: k3s.server,
    OPS_K8S_TOKEN_FILE: tokenFile,
    OPS_K8S_CA_FILE: options.caFile,
    OPS_KNOWN_SECRETS: options.knownSecrets.join(","),
  };

  const forms: string[] = [];
  const client = new Client({ name: "ops-lab", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler("elicitation/create", async (request) => {
    forms.push(request.params.message);
    return ANSWERS[options.answer];
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [WRITE_SERVER_ENTRY],
    env,
    stderr: "inherit",
  });
  await client.connect(transport);
  const { tools } = await client.listTools();

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isError: result.isError === true, text, json: parseJson(text) };
  };
  return { tools, forms, call, close: () => client.close() };
}
