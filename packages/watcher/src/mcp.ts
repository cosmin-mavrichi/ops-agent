import type Anthropic from "@anthropic-ai/sdk";
import { Client, type Implementation, type Tool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { ToolServer } from "./agent.js";
import type { Triage } from "./incidents.js";

export const toAnthropicTool = (tool: Tool): Anthropic.Tool => ({
  name: tool.name,
  description: tool.description ?? "",
  input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
});

const TriageReply = z.object({
  problems: z.record(z.string(), z.array(z.string())),
  clean: z.array(z.string()),
  unavailable: z.record(z.string(), z.string()),
  not_installed: z.record(z.string(), z.string()),
});

// In a pod the server finds the API server through these; they are not secrets.
const KUBERNETES_VARS = ["KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT"];

/**
 * The server gets only its own settings (OPS_*, not the watcher's OPS_WATCH_*): the model's API key never reaches
 * the process that touches infra, and the agent cannot ask that process for it.
 */
export function serverEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const isServerVar = (name: string) =>
    (name.startsWith("OPS_") && !name.startsWith("OPS_WATCH_")) || KUBERNETES_VARS.includes(name);
  const own = Object.entries(env).filter(
    (entry): entry is [string, string] => isServerVar(entry[0]) && entry[1] !== undefined,
  );
  return { ...getDefaultEnvironment(), ...Object.fromEntries(own) };
}

/** The write server's name (packages/mcp-write, `SERVER_NAME`). */
export const WRITE_SERVER_NAME = "ops-write";

/**
 * The watcher runs unattended, and the write server trusts its client to show each approval form to a human, so
 * the watcher must never connect to it. A guard against misconfiguration: the boundary is that the watcher never
 * holds a write credential.
 */
export function assertNotWriteServer(server: Implementation | undefined): void {
  if (server?.name === WRITE_SERVER_NAME) {
    throw new Error(`OPS_WATCH_SERVER points at the write server (${WRITE_SERVER_NAME}); the watcher only reads`);
  }
}

export interface Server {
  readonly tools: ToolServer;
  triage(): Promise<Triage>;
  close(): Promise<void>;
}

const textOf = (content: unknown) =>
  (content as ReadonlyArray<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

/** Starts the read-only MCP server as a child process and talks to it over stdio, like any MCP client. */
export async function connectServer(entry: string, env: Record<string, string>, onClose: () => void): Promise<Server> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "inherit" });
  const client = new Client({ name: "ops-watcher", version: "1.0.0" });
  await client.connect(transport);
  try {
    assertNotWriteServer(client.getServerVersion());
  } catch (err) {
    await client.close();
    throw err;
  }
  // Set only now, so a refused server is reported as refused rather than as a server that exited.
  client.onclose = onClose;

  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: input });
    return { text: textOf(result.content), isError: result.isError === true };
  };
  const triage = async () => {
    const { text, isError } = await call("ops_triage", {});
    if (isError) throw new Error(`ops_triage failed: ${text}`);
    return TriageReply.parse(JSON.parse(text));
  };
  const listTools = async () => (await client.listTools()).tools.map(toAnthropicTool);

  return { tools: { listTools, call }, triage, close: () => client.close() };
}
