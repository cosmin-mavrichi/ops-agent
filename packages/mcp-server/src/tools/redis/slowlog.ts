import { z } from "zod";
import { defineTool, Level } from "../../types.js";
import { maskKey, oneDecimal, secondsSince } from "./shared.js";

const MAX_LISTED = 25;

/** Commands whose second word is a subcommand (`CONFIG GET`), so the key, if any, is the third word. */
const CONTAINER_COMMANDS = new Set(["ACL", "CLIENT", "CLUSTER", "CONFIG", "FUNCTION", "MEMORY", "OBJECT", "SCRIPT"]);

// SLOWLOG GET entry: [id, unix time, duration in µs, [command, ...args], client address, client name].
const SlowlogReply = z.array(
  z.tuple([z.number(), z.number(), z.number(), z.array(z.string()), z.string(), z.string()]).rest(z.unknown()),
);
type SlowlogEntry = z.infer<typeof SlowlogReply>[number];

export interface SlowCommand {
  readonly command: string;
  readonly key_shape: string | null;
  readonly arg_count: number;
  readonly duration_ms: number;
  readonly ago_s: number;
  readonly client_name: string | null;
}

interface CommandTotal {
  readonly command: string;
  readonly count: number;
  readonly total_ms: number;
  readonly max_ms: number;
}

/** `["config", "set", "maxmemory", …]` → `CONFIG SET` and its key `maxmemory`. */
function commandAndKey(words: readonly string[]): { command: string; key: string | undefined } {
  const name = (words[0] ?? "?").toUpperCase();
  const subcommand = CONTAINER_COMMANDS.has(name) ? words[1] : undefined;
  if (subcommand === undefined) return { command: name, key: words[1] };
  return { command: `${name} ${subcommand.toUpperCase()}`, key: words[2] };
}

function toSlowCommand(entry: SlowlogEntry, now: Date): SlowCommand {
  const [_id, unixTime, durationUs, words, _clientAddress, clientName] = entry;
  const { command, key } = commandAndKey(words);
  const keyShape = key === undefined ? null : maskKey(key);
  return {
    command,
    key_shape: keyShape,
    arg_count: words.length - 1,
    duration_ms: oneDecimal(durationUs / 1000),
    ago_s: secondsSince(unixTime, now),
    client_name: clientName || null,
  };
}

/**
 * Arguments are never returned: they hold values (SET payloads, Lua scripts) and key names with user
 * data. Only the command, the masked shape of its key and the argument count are kept.
 */
export function parseSlowlog(reply: unknown, now: Date): SlowCommand[] {
  return SlowlogReply.parse(reply).map((entry) => toSlowCommand(entry, now));
}

function addToTotal(total: CommandTotal | undefined, entry: SlowCommand): CommandTotal {
  const previous = total ?? { command: entry.command, count: 0, total_ms: 0, max_ms: 0 };
  return {
    command: entry.command,
    count: previous.count + 1,
    total_ms: oneDecimal(previous.total_ms + entry.duration_ms),
    max_ms: Math.max(previous.max_ms, entry.duration_ms),
  };
}

const costliestFirst = (a: CommandTotal, b: CommandTotal) => b.total_ms - a.total_ms;

/** Totals per command, costliest first: one KEYS call can matter more than a hundred slow GETs. */
export function byCommand(entries: readonly SlowCommand[]): CommandTotal[] {
  const totals = new Map<string, CommandTotal>();
  for (const entry of entries) totals.set(entry.command, addToTotal(totals.get(entry.command), entry));
  return [...totals.values()].toSorted(costliestFirst);
}

interface WholeRead {
  readonly reads: string;
  readonly instead: string;
}

/** Commands that read a whole keyspace or collection in one call, and the incremental command to use instead. */
const WHOLE_READS: Readonly<Partial<Record<string, WholeRead>>> = {
  KEYS: { reads: "keyspace", instead: "SCAN" },
  HGETALL: { reads: "hash", instead: "HSCAN" },
  SMEMBERS: { reads: "set", instead: "SSCAN" },
};

const clientsOf = (command: string, entries: readonly SlowCommand[]) => {
  const names = entries.filter((entry) => entry.command === command).map((entry) => entry.client_name ?? "unnamed");
  return [...new Set(names)].join(", ");
};

/**
 * Milliseconds look harmless, so the model tends to dismiss them; spelled out, a whole-collection read is the
 * textbook cause of stalls that hit every client at once.
 */
export function problemsOf(totals: readonly CommandTotal[], entries: readonly SlowCommand[]): string[] {
  return totals.flatMap(({ command, count, max_ms }) => {
    const whole = WHOLE_READS[command];
    if (whole === undefined) return [];
    const calls = count === 1 ? "1 slow call" : `${count} slow calls`;
    return [
      `${command} from ${clientsOf(command, entries)} (${calls}, up to ${max_ms} ms) reads the whole ` +
        `${whole.reads} in one call: every other client waits while it runs, and it gets slower as the data ` +
        `grows. Use ${whole.instead} instead.`,
    ];
  });
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
    "client; `problems` names the whole-keyspace or whole-collection reads and their incremental replacement. " +
    "Key names are masked to their shape (`session:?`) and arguments are never returned. Use when " +
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
    const totals = byCommand(entries);
    return {
      logged_total: Number(total),
      problems: problemsOf(totals, entries),
      by_command: totals,
      entries: entries.slice(0, MAX_LISTED),
    };
  },
});
