import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { type RegistryOptions, registerTools, type ToolList } from "@ops-agent/mcp-server/shared";
import type { WriteContext } from "./types.js";

/**
 * The watcher refuses a server with this name (packages/watcher/src/mcp.ts): a client that runs unattended must
 * never reach write tools.
 */
export const SERVER_NAME = "ops-write";

export interface WriteServerOptions {
  readonly tools: ToolList<WriteContext>;
  readonly registry: RegistryOptions<WriteContext>;
  /** Checks a requestState before the tool sees it, and returns its payload (the HMAC codec's verify). */
  readonly verifyState: (state: string, ctx: ServerContext) => Promise<unknown>;
}

export interface WriteServer {
  readonly server: McpServer;
  readonly exposed: readonly string[];
}

export function createWriteServer(opts: WriteServerOptions): WriteServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: "0.1.0" },
    { capabilities: { tools: {} }, requestState: { verify: opts.verifyState } },
  );
  const exposed = registerTools(server, opts.tools, opts.registry);
  return { server, exposed };
}
