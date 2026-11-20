import type { RedisClient } from "../../../src/types.js";

export const NOW = new Date("2026-11-20T12:00:00Z");
export const unixAgo = (seconds: number) => Math.round(NOW.getTime() / 1000) - seconds;

/** Fake server that answers by command prefix (e.g. "SLOWLOG GET") and records what was sent. */
export function fakeRedis(replies: Record<string, unknown>) {
  const sent: string[][] = [];
  const client: RedisClient = {
    send: async (command) => {
      sent.push([...command]);
      const text = command.join(" ");
      const match = Object.keys(replies).find((prefix) => text.startsWith(prefix));
      if (match === undefined) throw new Error(`no fake reply for ${text}`);
      return replies[match];
    },
  };
  return { client, sent };
}

/** INFO from a Valkey that is full, refuses writes and failed its last snapshot. */
export const FULL_VALKEY_INFO = [
  "# Server",
  "redis_version:7.2.4",
  "server_name:valkey",
  "valkey_version:9.0.1",
  "uptime_in_seconds:86400",
  "",
  "# Clients",
  "connected_clients:42",
  "blocked_clients:0",
  "maxclients:10000",
  "",
  "# Memory",
  "used_memory:2040109",
  "maxmemory:2097152",
  "maxmemory_policy:noeviction",
  "mem_fragmentation_ratio:1.12",
  "",
  "# Persistence",
  `rdb_last_save_time:${unixAgo(7_200)}`,
  "rdb_last_bgsave_status:err",
  "aof_enabled:0",
  "aof_last_write_status:ok",
  "",
  "# Stats",
  "instantaneous_ops_per_sec:850",
  "rejected_connections:0",
  "evicted_keys:0",
  "expired_keys:310",
  "keyspace_hits:900",
  "keyspace_misses:100",
  "total_error_replies:57",
  "",
  "# Replication",
  "role:master",
  "connected_slaves:0",
  "",
  "# Errorstats",
  "errorstat_OOM:count=55",
  "errorstat_WRONGTYPE:count=2",
  "",
  "# Keyspace",
  "db0:keys=1520,expires=12,avg_ttl=0",
  "",
].join("\r\n");

export const CLIENT_LIST = [
  "id=3 addr=10.42.0.9:51234 laddr=10.42.0.5:6379 fd=8 name=checkout age=600 idle=0 flags=N db=0 cmd=set user=app",
  "id=4 addr=10.42.0.9:51236 laddr=10.42.0.5:6379 fd=9 name=checkout age=600 idle=12 flags=N db=0 cmd=get user=app",
  "id=5 addr=10.42.0.7:40100 laddr=10.42.0.5:6379 fd=10 name= lib-name=ioredis age=90 idle=3 db=0 cmd=get user=app",
  "id=6 addr=10.42.0.3:39000 laddr=10.42.0.5:6379 fd=11 name=ops-mcp age=0 idle=0 db=0 cmd=client|list user=ops_ro",
  "",
].join("\n");
