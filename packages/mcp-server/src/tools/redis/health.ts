import { defineTool, Level } from "../../types.js";
import { parseInfo, parsePairs } from "./shared.js";

const INFO_SECTIONS = ["server", "clients", "memory", "persistence", "stats", "replication", "keyspace", "errorstats"];
const OWN_CONNECTION = "ops-mcp";
const MAX_CLIENT_GROUPS = 10;
const MIB = 1024 * 1024;

type Info = ReadonlyMap<string, string>;

const numberIn = (info: Info, field: string): number | null => {
  const value = info.get(field);
  return value === undefined || value === "" ? null : Number(value);
};

const toMib = (bytes: number | null) => (bytes === null ? null : Math.round((bytes / MIB) * 10) / 10);

function summarizeMemory(info: Info) {
  const used = numberIn(info, "used_memory");
  const maxmemory = numberIn(info, "maxmemory");
  const limit = maxmemory ? maxmemory : null; // 0 means no limit
  return {
    used_mb: toMib(used),
    max_mb: toMib(limit),
    used_pct: used !== null && limit !== null ? Math.round((100 * used) / limit) : null,
    policy: info.get("maxmemory_policy") ?? null,
    fragmentation_ratio: numberIn(info, "mem_fragmentation_ratio"),
    evicted_keys: numberIn(info, "evicted_keys"),
  };
}

/** `errorstat_OOM:count=12` lines → { OOM: 12 }. */
function errorsByType(info: Info): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const [field, value] of info) {
    if (!field.startsWith("errorstat_")) continue;
    byType[field.slice("errorstat_".length)] = Number(parsePairs(value, ",").get("count") ?? 0);
  }
  return byType;
}

/** `db0:keys=12,expires=3,avg_ttl=0` lines → { db0: { keys: 12, expires: 3 } }. */
function keyspace(info: Info): Record<string, { keys: number; expires: number }> {
  const databases: Record<string, { keys: number; expires: number }> = {};
  for (const [field, value] of info) {
    if (!/^db\d+$/.test(field)) continue;
    const pairs = parsePairs(value, ",");
    databases[field] = { keys: Number(pairs.get("keys") ?? 0), expires: Number(pairs.get("expires") ?? 0) };
  }
  return databases;
}

function hitPercent(info: Info): number | null {
  const hits = numberIn(info, "keyspace_hits") ?? 0;
  const misses = numberIn(info, "keyspace_misses") ?? 0;
  const lookups = hits + misses;
  return lookups > 0 ? Math.round((100 * hits) / lookups) : null;
}

/** CLIENT LIST, one line per connection, grouped by client name and ACL user. Excludes the agent itself. */
export function summarizeClients(clientList: string) {
  const groups = new Map<string, { name: string; user: string; connections: number; max_idle_s: number }>();

  for (const line of clientList.split("\n")) {
    const client = parsePairs(line.trim(), " ");
    if (client.size === 0 || client.get("name") === OWN_CONNECTION) continue;

    const name = client.get("name") || client.get("lib-name") || "(unnamed)";
    const user = client.get("user") ?? "default";
    const idle = Number(client.get("idle") ?? 0);
    const key = `${name}\u0000${user}`;
    const group = groups.get(key) ?? { name, user, connections: 0, max_idle_s: 0 };
    groups.set(key, { ...group, connections: group.connections + 1, max_idle_s: Math.max(group.max_idle_s, idle) });
  }

  return [...groups.values()].toSorted((a, b) => b.connections - a.connections).slice(0, MAX_CLIENT_GROUPS);
}

/**
 * Valkey also reports `redis_version`, frozen at 7.2.4 for client compatibility, so the real version
 * comes from `valkey_version` when present.
 */
function serverOf(info: Info) {
  const valkey = info.get("valkey_version");
  if (valkey) return { server: "valkey", version: valkey };
  return { server: info.get("server_name") ?? "redis", version: info.get("redis_version") ?? null };
}

/** The numbers, without interpretation. */
export function measureHealth(info: Info, clientList: string, now: Date) {
  const lastSave = numberIn(info, "rdb_last_save_time");
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
      rdb_last_save_ago_s: lastSave === null ? null : Math.max(0, Math.round(now.getTime() / 1000 - lastSave)),
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

/** The conclusions an operator would draw first, spelled out so the model doesn't have to. */
export function warningsFor(health: Measurements): string[] {
  const { memory, clients, errors, persistence, replication } = health;
  const warnings: string[] = [];

  if (memory.max_mb === null) {
    warnings.push("no maxmemory limit: Redis grows until the container or node runs out of memory");
  } else if ((memory.used_pct ?? 0) >= 90) {
    const effect =
      memory.policy === "noeviction" ? "writes fail with OOM errors once it is full" : "keys are being evicted";
    warnings.push(`memory at ${memory.used_pct}% of maxmemory with policy ${memory.policy}: ${effect}`);
  }
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
    "Health of the Redis-compatible server (Redis or Valkey) from INFO and CLIENT LIST: memory against maxmemory and the eviction policy, evicted keys, " +
    "connected/blocked/rejected clients grouped by client name, error replies by type (OOM, NOAUTH…), hit " +
    "rate, persistence status and replication link. Counters are cumulative since `uptime_s`. `warnings` " +
    "lists the likely problems. Use when an application reports Redis timeouts, OOM errors, connection " +
    "errors or slow cache. For slow commands use redis_slowlog. Never returns keys or values.",
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
