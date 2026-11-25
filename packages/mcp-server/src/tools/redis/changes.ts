import { describeSpan } from "../../lib/units.js";
import { defineTool, Level } from "../../types.js";
import { countIn, numberIn, parseInfo, serverOf } from "./shared.js";

const INFO_SECTIONS = ["server", "persistence", "replication", "keyspace", "commandstats"] as const;
const COMMANDSTAT_PREFIX = "cmdstat_";
const DATABASE_FIELD = /^db\d+$/;
// Replication IDs are 40 hex characters; all zeros means there is no previous one.
const NO_PREVIOUS_ID = /^0+$/;
const RESETSTAT = "config|resetstat";

/** Commands that change the server's data, settings or connections, as INFO commandstats names them. */
const ADMIN_COMMANDS = {
  flushall: "deleted every key in every database",
  flushdb: "deleted every key in one database",
  swapdb: "swapped the contents of two databases",
  "config|set": "changed settings at runtime (values not shown; redis_health shows the memory settings)",
  "config|rewrite": "wrote the runtime settings into the config file",
  "acl|setuser": "created users or changed their permissions",
  "acl|deluser": "deleted users",
  "acl|load": "reloaded users from the ACL file",
  "client|kill": "closed client connections",
  "client|pause": "paused clients",
  replicaof: "changed which server this one replicates",
  slaveof: "changed which server this one replicates",
  failover: "started a manual failover",
  "cluster|failover": "started a manual cluster failover",
  "script|flush": "removed the cached Lua scripts: EVALSHA fails with NOSCRIPT until each script is loaded again",
  "function|flush": "removed every function library",
  "function|delete": "removed a function library",
  "module|load": "loaded a module",
  "module|unload": "unloaded a module",
  debug: "ran DEBUG (it can reload the data, pause or crash the server)",
  "slowlog|reset": "cleared the slow log",
  "latency|reset": "cleared the latency history",
} as const;

type AdminCommand = keyof typeof ADMIN_COMMANDS;
type Info = ReadonlyMap<string, string>;

const isAdminCommand = (name: string): name is AdminCommand => Object.hasOwn(ADMIN_COMMANDS, name);

interface RedisChange {
  /** Unknown for a promotion: the server keeps no time for it. */
  readonly at_ago_s: number | null;
  readonly kind: "restart" | "promotion" | "primary_changed" | "primary_link_down";
  readonly change: string;
}

interface AdminRun {
  readonly command: string;
  readonly runs: number;
  readonly effect: string;
}

/** `config|set` → `CONFIG SET`, as an operator would type it. */
const commandText = (name: string) => name.replace("|", " ").toUpperCase();

/** `cmdstat_flushall:calls=2,...,failed_calls=0` lines → the admin commands that ran, failed calls left out. */
export function adminRuns(info: Info): AdminRun[] {
  return [...info].flatMap(([field, stats]) => {
    if (!field.startsWith(COMMANDSTAT_PREFIX)) return [];
    const name = field.slice(COMMANDSTAT_PREFIX.length);
    if (!isAdminCommand(name)) return [];
    const runs = countIn(stats, "calls") - countIn(stats, "failed_calls");
    if (runs <= 0) return [];
    return [{ command: commandText(name), runs, effect: ADMIN_COMMANDS[name] }];
  });
}

function restartChange(info: Info, uptimeS: number): RedisChange {
  const loaded = numberIn(info, "rdb_last_load_keys_loaded");
  const started = "server started (a restart or new instance): every connection was dropped";
  if (loaded === null) return { at_ago_s: uptimeS, kind: "restart", change: started };
  const cache = loaded === 0 ? "nothing was loaded from disk, so the cache started empty" : `${loaded} keys loaded`;
  return { at_ago_s: uptimeS, kind: "restart", change: `${started}; ${cache}` };
}

/** After a promotion the server keeps the old replication ID as `master_replid2`, so it can still serve old replicas. */
function promotionChange(info: Info): RedisChange | undefined {
  const previousId = info.get("master_replid2") ?? "0";
  if (NO_PREVIOUS_ID.test(previousId)) return undefined;
  if (info.get("role") === "master") {
    return { at_ago_s: null, kind: "promotion", change: "this server was a replica and became the primary" };
  }
  return { at_ago_s: null, kind: "primary_changed", change: "the primary this replica follows changed (a failover)" };
}

function linkDownChange(info: Info): RedisChange | undefined {
  const downS = numberIn(info, "master_link_down_since_seconds");
  if (info.get("master_link_status") !== "down" || downS === null || downS < 0) return undefined;
  return { at_ago_s: downS, kind: "primary_link_down", change: "this replica lost its link to the primary" };
}

function totalKeys(info: Info): number {
  const databases = [...info].filter(([field]) => DATABASE_FIELD.test(field));
  const keysPerDatabase = databases.map(([, value]) => countIn(value, "keys"));
  return keysPerDatabase.reduce((sum, keys) => sum + keys, 0);
}

function countedSince(info: Info, uptimeS: number): string {
  const started = `the server started ${describeSpan(uptimeS)} ago`;
  if (!info.has(`${COMMANDSTAT_PREFIX}${RESETSTAT}`)) return started;
  return `CONFIG RESETSTAT, at an unrecorded time after ${started}`;
}

export function summarizeChanges(info: Info) {
  const uptimeS = numberIn(info, "uptime_in_seconds") ?? 0;
  const changes = [restartChange(info, uptimeS), promotionChange(info), linkDownChange(info)];
  return {
    ...serverOf(info),
    keys: totalKeys(info),
    changes: changes.filter((change) => change !== undefined),
    admin_commands: adminRuns(info),
    admin_commands_since: countedSince(info, uptimeS),
  };
}

export const redisChanges = defineTool({
  name: "redis_changes",
  level: Level.Read,
  requires: ["redis"],
  title: "Redis/Valkey: what changed",
  description:
    "What changed in the Redis-compatible server (Redis or Valkey): when it last started (a restart drops every " +
    "connection, and the cache may start empty), a failover (this server promoted, or its primary changed), a " +
    "replica's lost link to its primary, and admin commands that ran since start: FLUSHALL/FLUSHDB (every key " +
    "deleted), CONFIG SET, SCRIPT FLUSH, CLIENT KILL, ACL changes and others, with how many times. The server " +
    "does not record when an admin command ran, only that it ran since `admin_commands_since`; compare with " +
    "`keys` (keys now) and redis_health's hit rate. Use when the cache seems empty or cold, or the database is " +
    "suddenly busier. A change close in time is a lead, not proof. Never returns keys, values or settings.",
  input: {},
  timeoutMs: 8_000,

  async run(_args, { redis, signal }) {
    const info = await redis.send(["INFO", ...INFO_SECTIONS], signal);
    return summarizeChanges(parseInfo(String(info)));
  },
});
