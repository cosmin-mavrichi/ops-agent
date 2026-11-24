// A stand-in MCP server over stdio that only answers `initialize`, naming itself after $SERVER_NAME.
import { createInterface } from "node:readline";

const name = process.env.SERVER_NAME ?? "ops";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method !== "initialize") continue;
  const result = {
    protocolVersion: message.params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name, version: "0.0.0" },
  };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
