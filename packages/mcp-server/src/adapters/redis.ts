import { createClient } from "@redis/client";
import type { RedisClient } from "../types.js";

export interface RedisConfig {
  /** Must authenticate as the ops_ro ACL user (see deploy/redis/ops-ro.acl). */
  url: string;
  timeoutMs?: number;
  /** Connection errors are also emitted as events; without a handler Node crashes the process. */
  onError: (err: Error) => void;
}

/** The commands tools may send, matched as prefixes: ["SLOWLOG", "GET"] allows `SLOWLOG GET 25`. */
const ALLOWED_COMMANDS: ReadonlyArray<readonly string[]> = [
  ["PING"],
  ["INFO"],
  ["SLOWLOG", "GET"],
  ["SLOWLOG", "LEN"],
  ["CLIENT", "LIST"],
  ["LATENCY", "LATEST"],
];

export function isAllowedCommand(command: readonly string[]): boolean {
  const startsWith = (allowed: readonly string[]) => allowed.every((word, i) => command[i]?.toUpperCase() === word);
  return ALLOWED_COMMANDS.some(startsWith);
}

/**
 * Read-only Redis client. Defence in depth:
 *  1. the ops_ro ACL user may only run these commands and has no access to keys,
 *  2. this adapter refuses any other command before sending it,
 *  3. tools never ask for values, and mask key names they report.
 * Each call opens its own short connection: diagnostic calls are rare, and it avoids reconnect state.
 */
export function createRedisClient(cfg: RedisConfig): RedisClient {
  const timeout = cfg.timeoutMs ?? 5_000;

  return {
    async send(command, signal) {
      if (!isAllowedCommand(command)) throw new Error(`redis command not allowed: ${command[0]}`);

      const client = createClient({
        url: cfg.url,
        name: "ops-mcp",
        RESP: 2,
        // CLIENT SETINFO is not in the ACL; the name above already identifies the agent.
        disableClientInfo: true,
        disableOfflineQueue: true,
        socket: { connectTimeout: timeout, socketTimeout: timeout, reconnectStrategy: false },
      });
      client.on("error", cfg.onError);
      try {
        await client.connect();
        return await client.sendCommand([...command], { abortSignal: signal });
      } finally {
        client.destroy();
      }
    },
  };
}
