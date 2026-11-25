import { AGENT_CLIENT_NAME, defineTool, Level } from "../../types.js";
import { countIn, numberIn, oneDecimal, parseInfo, parsePairs, secondsSince, serverOf } from "./shared.js";

const INFO_SECTIONS = [
  "server",
  "clients",
  "memory",
  "persistence",
  "stats",
  "replication",
  "keyspace",
  "errorstats",
] as const;
const MAX_CLIENT_GROUPS = 10;
const MIB = 1024 * 1024;
const NEAR_FULL_PCT = 90;
const ERRORSTAT_PREFIX = "errorstat_";
const DATABASE_FIELD = /^db\d+$/;

type Info = ReadonlyMap<string, string>;

const toMib = (bytes: number | null) => (bytes === null ? null : oneDecimal(bytes / MIB));

const percent = (part: number, whole: number) => Math.round((100 * part) / whole);

function summarizeMemory(info: Info) {
  const used = numberIn(info, "used_memory");
  const limit = numberIn(info, "maxmemory") || null; // 0 means no limit
  const usedPct = used !== null && limit !== null ? percent(used, limit) : null;
  return {
    used_mb: toMib(used),
    max_mb: toMib(limit),
    used_pct: usedPct,
    policy: info.get("maxmemory_policy") ?? null,
    fragmentation_ratio: numberIn(info, "mem_fragmentation_ratio"),
    evicted_keys: numberIn(info, "evicted_keys"),
  };
}

/** `errorstat_OOM:count=12` lines → { OOM: 12 }. */
function errorsByType(info: Info): Record<string, number> {
  const errorFields = [...info].filter(([field]) => field.startsWith(ERRORSTAT_PREFIX));
  const counts = errorFields.map(([field, value]) => [field.slice(ERRORSTAT_PREFIX.length), countIn(value, "count")]);
  return Object.fromEntries(counts);
}

/** `db0:keys=12,expires=3,avg_ttl=0` lines → { db0: { keys: 12, expires: 3 } }. */
function keyspace(info: Info): Record<string, { keys: number; expires: number }> {
  const databaseFields = [...info].filter(([field]) => DATABASE_FIELD.test(field));
  const databases = databaseFields.map(([db, value]) => [
    db,
    { keys: countIn(value, "keys"), expires: countIn(value, "expires") },
  ]);
  return Object.fromEntries(databases);
}

function hitPercent(info: Info): number | null {
  const hits = numberIn(info, "keyspace_hits") ?? 0;
  const misses = numberIn(info, "keyspace_misses") ?? 0;
  const lookups = hits + misses;
  return lookups > 0 ? percent(hits, lookups) : null;
}

interface Connection {
  readonly name: string;
  readonly user: string;
  readonly idle_s: number;
}

interface ClientGroup {
  readonly name: string;
  readonly user: string;
  readonly connections: number;
  readonly max_idle_s: number;
}

/** One CLIENT LIST line; undefined for blank lines and for the agent's own connection. */
function toConnection(line: string): Connection | undefined {
  const client = parsePairs(line.trim(), " ");
  if (client.size === 0 || client.get("name") === AGENT_CLIENT_NAME) return undefined;
  return {
    name: client.get("name") || client.get("lib-name") || "(unnamed)",
    user: client.get("user") ?? "default",
    idle_s: Number(client.get("idle") ?? 0),
  };
}

function addToGroup(group: ClientGroup | undefined, connection: Connection): ClientGroup {
  return {
    name: connection.name,
    user: connection.user,
    connections: (group?.connections ?? 0) + 1,
    max_idle_s: Math.max(group?.max_idle_s ?? 0, connection.idle_s),
  };
}

const mostConnectionsFirst = (a: ClientGroup, b: ClientGroup) => b.connections - a.connections;

/** CLIENT LIST, one line per connection, grouped by client name and ACL user. Excludes the agent itself. */
export function summarizeClients(clientList: string): ClientGroup[] {
  const connections = clientList.split("\n").map(toConnection);
  const groups = new Map<string, ClientGroup>();
  for (const connection of connections) {
    if (connection === undefined) continue;
    const key = `${connection.name}\u0000${connection.user}`;
    groups.set(key, addToGroup(groups.get(key), connection));
  }
  return [...groups.values()].toSorted(mostConnectionsFirst).slice(0, MAX_CLIENT_GROUPS);
}

/** The numbers, without interpretation. */
export function measureHealth(info: Info, clientList: string, now: Date) {
  const lastSave = numberIn(info, "rdb_last_save_time");
  const lastSaveAgo = lastSave === null ? null : secondsSince(lastSave, now);
  return {
    ...serverOf(info),
    uptime_s: numberIn(info, "uptime_in_seconds"),
    role: info.get("role") ?? null,
    memory: summarizeMemory(info),
    clients: {
      connected: numberIn(info, "connected_clients"),
      blocked: numberIn(info, "blocked_clients"),
      max: numberIn(info, "maxclients"),
      rejected_connections: numberIn(info, "rejected_connections"),
      top: summarizeClients(clientList),
    },
    errors: { total: numberIn(info, "total_error_replies"), by_type: errorsByType(info) },
    stats: {
      ops_per_sec: numberIn(info, "instantaneous_ops_per_sec"),
      keyspace_hit_pct: hitPercent(info),
      expired_keys: numberIn(info, "expired_keys"),
    },
    persistence: {
      rdb_last_save_ago_s: lastSaveAgo,
      rdb_last_bgsave_status: info.get("rdb_last_bgsave_status") ?? null,
      aof_enabled: info.get("aof_enabled") === "1",
      aof_last_write_status: info.get("aof_last_write_status") ?? null,
    },
    replication: {
      connected_replicas: numberIn(info, "connected_slaves"),
      primary_link_status: info.get("master_link_status") ?? null,
    },
    keyspace: keyspace(info),
  };
}

type Measurements = ReturnType<typeof measureHealth>;

export function summarizeHealth(info: Info, clientList: string, now: Date) {
  const measurements = measureHealth(info, clientList, now);
  return { ...measurements, warnings: warningsFor(measurements) };
}

function memoryWarning(memory: Measurements["memory"]): string | undefined {
  if (memory.max_mb === null) {
    return "no maxmemory limit: Redis grows until the container or node runs out of memory";
  }
  if ((memory.used_pct ?? 0) < NEAR_FULL_PCT) return undefined;

  const effect =
    memory.policy === "noeviction" ? "writes fail with OOM errors once it is full" : "keys are being evicted";
  return `memory at ${memory.used_pct}% of maxmemory with policy ${memory.policy}: ${effect}`;
}

/** The conclusions an operator would draw first, spelled out so the model doesn't have to. */
export function warningsFor(health: Measurements): string[] {
  const { memory, clients, errors, persistence, replication } = health;
  const warnings: string[] = [];

  const memoryProblem = memoryWarning(memory);
  if (memoryProblem) warnings.push(memoryProblem);
  const oom = errors.by_type.OOM ?? 0;
  if (oom > 0) warnings.push(`${oom} commands were rejected with OOM (out of memory) since start`);
  if ((clients.rejected_connections ?? 0) > 0) {
    warnings.push(`${clients.rejected_connections} connections were rejected: maxclients (${clients.max}) reached`);
  }
  if ((clients.blocked ?? 0) > 0) warnings.push(`${clients.blocked} clients are blocked in a waiting command`);
  if (persistence.rdb_last_bgsave_status === "err") warnings.push("the last RDB snapshot failed");
  if (persistence.aof_last_write_status === "err") warnings.push("the last AOF write failed");
  if (replication.primary_link_status === "down") warnings.push("this replica lost its link to the primary");

  return warnings;
}

export const redisHealth = defineTool({
  name: "redis_health",
  level: Level.Read,
  requires: ["redis"],
  title: "Redis/Valkey: memory, clients and errors",
  description:
    "Health of the Redis-compatible server (Redis or Valkey) from INFO and CLIENT LIST: memory against " +
    "maxmemory and the eviction policy, evicted keys, connected/blocked/rejected clients grouped by client " +
    "name, error replies by type (OOM, NOAUTH…), hit rate, persistence status and replication link. Counters " +
    "are cumulative since `uptime_s`. `warnings` lists the likely problems. Use when an application reports " +
    "Redis timeouts, OOM errors, connection errors or slow cache. For slow commands use redis_slowlog. Never " +
    "returns keys or values.",
  input: {},
  timeoutMs: 8_000,

  async run(_args, { redis, signal }) {
    const [info, clientList] = await Promise.all([
      redis.send(["INFO", ...INFO_SECTIONS], signal),
      redis.send(["CLIENT", "LIST"], signal),
    ]);
    return summarizeHealth(parseInfo(String(info)), String(clientList), new Date());
  },
});
