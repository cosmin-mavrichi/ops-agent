import { Client } from "@modelcontextprotocol/client";
// Both halves of the linked pair must come from the same package (each bundles its own copy).
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach } from "vitest";
import { createRedactor } from "../src/lib/redact.js";
import { type AuditEntry, registerTools } from "../src/registry.js";
import {
  type K8sClient,
  Level,
  type PromClient,
  type RedisClient,
  type SqlClient,
  type ToolDef,
} from "../src/types.js";

/**
 * Spins up a real MCP server + client over an in-memory transport.
 * Tests go through the actual protocol (listTools / callTool), same path the agent uses.
 */
export interface HarnessOptions {
  tools: ToolDef<any>[];
  pg?: SqlClient;
  k8s?: K8sClient;
  redis?: RedisClient;
  prom?: PromClient;
  maxLevel?: Level;
  knownSecrets?: string[];
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export async function startHarness(opts: HarnessOptions) {
  const audit: AuditEntry[] = [];
  const server = new McpServer({ name: "ops-test", version: "0.0.0" }, { capabilities: { tools: {} } });
  const exposed = registerTools(server, opts.tools, {
    maxLevel: opts.maxLevel ?? Level.Read,
    redact: createRedactor(opts.knownSecrets ?? []),
    context: (signal) => ({
      pg: opts.pg ?? missingPg,
      k8s: opts.k8s ?? missingK8s,
      redis: opts.redis ?? missingRedis,
      prom: opts.prom ?? missingProm,
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
      return { isError: res.isError === true, text, json: parseJson(text) };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Starts a harness inside a test and closes it after that test. */
export function useHarness() {
  let current: Harness | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  return async (opts: HarnessOptions) => {
    current = await startHarness(opts);
    return current;
  };
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const notInThisTest = (adapter: string) => async (): Promise<never> => {
  throw new Error(`no ${adapter} in this test`);
};
const missingPg: SqlClient = { query: notInThisTest("pg") };
const missingK8s: K8sClient = { namespaces: [], getJson: notInThisTest("k8s"), getText: notInThisTest("k8s") };
const missingRedis: RedisClient = { send: notInThisTest("redis") };
const missingProm: PromClient = { query: notInThisTest("prometheus") };
