import { z } from "zod";
import { defineTool, Level } from "../../types.js";
import { maskKey } from "./shared.js";

const MAX_LISTED = 25;

/** Commands whose second word is a subcommand (`CONFIG GET`), so the key, if any, is the third word. */
const CONTAINER_COMMANDS = new Set(["ACL", "CLIENT", "CLUSTER", "CONFIG", "FUNCTION", "MEMORY", "OBJECT", "SCRIPT"]);

// SLOWLOG GET entry: [id, unix time, duration in µs, [command, ...args], client address, client name].
const SlowlogReply = z.array(
  z.tuple([z.number(), z.number(), z.number(), z.array(z.string()), z.string(), z.string()]).rest(z.unknown()),
);

export interface SlowCommand {
  readonly command: string;
  readonly key_shape: string | null;
  readonly arg_count: number;
  readonly duration_ms: number;
  readonly ago_s: number;
  readonly client_name: string | null;
}

/**
 * Arguments are never returned: they hold values (SET payloads, Lua scripts) and key names with user
 * data. Only the command, the masked shape of its key and the argument count are kept.
 */
export function parseSlowlog(reply: unknown, now: Date): SlowCommand[] {
  return SlowlogReply.parse(reply).map(([_id, unixTime, durationUs, words, _clientAddress, clientName]) => {
    const name = (words[0] ?? "?").toUpperCase();
    const hasSubcommand = CONTAINER_COMMANDS.has(name) && words.length > 1;
    const command = hasSubcommand ? `${name} ${(words[1] ?? "").toUpperCase()}` : name;
    const key = hasSubcommand ? words[2] : words[1];
    return {
      command,
      key_shape: key === undefined ? null : maskKey(key),
      arg_count: words.length - 1,
      duration_ms: Math.round(durationUs / 100) / 10,
      ago_s: Math.max(0, Math.round(now.getTime() / 1000 - unixTime)),
      client_name: clientName || null,
    };
  });
}

/** Totals per command, costliest first: one KEYS call can matter more than a hundred slow GETs. */
export function byCommand(entries: readonly SlowCommand[]) {
  const totals = new Map<string, { command: string; count: number; total_ms: number; max_ms: number }>();
  for (const { command, duration_ms } of entries) {
    const total = totals.get(command) ?? { command, count: 0, total_ms: 0, max_ms: 0 };
    totals.set(command, {
      command,
      count: total.count + 1,
      total_ms: Math.round((total.total_ms + duration_ms) * 10) / 10,
      max_ms: Math.max(total.max_ms, duration_ms),
    });
  }
  return [...totals.values()].toSorted((a, b) => b.total_ms - a.total_ms);
}

export const redisSlowlog = defineTool({
  name: "redis_slowlog",
  level: Level.Read,
  requires: ["redis"],
  title: "Redis/Valkey: slow commands",
  description:
    "Recent commands the server (Redis or Valkey) logged as slow, i.e. slower than " +
    "slowlog-log-slower-than (10ms by default), newest first, with totals per command. Commands run one at a " +
    "time, so one slow command (KEYS, a big HGETALL or SMEMBERS, a long Lua script) delays every other " +
    "client. Key names are masked to their shape (`session:?`) and arguments are never returned. Use when " +
    "latency spikes or clients time out.",
  input: {
    limit: z.number().int().min(1).max(128).default(50),
  },
  timeoutMs: 8_000,

  async run({ limit }, { redis, signal }) {
    const [reply, total] = await Promise.all([
      redis.send(["SLOWLOG", "GET", String(limit)], signal),
      redis.send(["SLOWLOG", "LEN"], signal),
    ]);
    const entries = parseSlowlog(reply, new Date());
    return {
      logged_total: Number(total),
      by_command: byCommand(entries),
      entries: entries.slice(0, MAX_LISTED),
    };
  },
});
