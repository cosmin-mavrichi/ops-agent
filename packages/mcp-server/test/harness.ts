import { Client } from "@modelcontextprotocol/client";
// Both halves of the linked pair must come from the same package (each bundles its own copy).
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { createRedactor } from "../src/lib/redact.js";
import { type AuditEntry, registerTools } from "../src/registry.js";
import { type K8sClient, Level, type SqlClient, type ToolDef } from "../src/types.js";

/**
 * Spins up a real MCP server + client over an in-memory transport.
 * Tests go through the actual protocol (listTools / callTool), same path the agent uses.
 */
export async function startHarness(opts: {
  tools: ToolDef<any>[];
  pg?: SqlClient;
  k8s?: K8sClient;
  maxLevel?: Level;
  knownSecrets?: string[];
}) {
  const audit: AuditEntry[] = [];
  const server = new McpServer({ name: "ops-test", version: "0.0.0" }, { capabilities: { tools: {} } });
  const exposed = registerTools(server, opts.tools, {
    maxLevel: opts.maxLevel ?? Level.Read,
    redact: createRedactor(opts.knownSecrets ?? []),
    context: (signal) => ({
      pg: opts.pg ?? {
        query: async () => {
          throw new Error("no pg in this test");
        },
      },
      k8s: opts.k8s ?? missingK8s,
      signal,
      log: () => {},
    }),
    audit: (e) => audit.push(e),
  });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    exposed,
    audit,
    /** Calls a tool and returns parsed JSON + error flag. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name, arguments: args });
      const first = (res.content as Array<{ type: string; text?: string }>)[0];
      const text = first?.text ?? "";
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: res.isError === true, text, json };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const missing = async (): Promise<never> => {
  throw new Error("no k8s in this test");
};
const missingK8s: K8sClient = { namespaces: [], getJson: missing, getText: missing };
