import { describe, expect, it } from "vitest";
import { adminRuns, redisChanges, summarizeChanges } from "../../../src/tools/redis/changes.js";
import { parseInfo } from "../../../src/tools/redis/shared.js";
import { useHarness } from "../../harness.js";
import { fakeRedis } from "./fake-redis.js";

const harness = useHarness();

/** INFO from a Valkey replica that was promoted, then flushed by someone, with commandstats as Valkey 9 prints them. */
const FLUSHED_VALKEY_INFO = [
  "# Server",
  "redis_version:7.2.4",
  "server_name:valkey",
  "valkey_version:9.0.1",
  "uptime_in_seconds:7200",
  "",
  "# Persistence",
  "rdb_last_load_keys_expired:0",
  "rdb_last_load_keys_loaded:15230",
  "",
  "# Replication",
  "role:master",
  "connected_slaves:0",
  "master_replid:d70d7109e8690688beaab2d71c459b5676219a1e",
  "master_replid2:c268329896fa81bf1b4a7243501d3e981b7b4811",
  "second_repl_offset:1",
  "",
  "# Commandstats",
  "cmdstat_get:calls=90211,usec=40000,usec_per_call=0.44,rejected_calls=0,failed_calls=0",
  "cmdstat_flushall:calls=1,usec=21018,usec_per_call=21018.00,rejected_calls=0,failed_calls=0",
  "cmdstat_config|set:calls=3,usec=12,usec_per_call=4.00,rejected_calls=0,failed_calls=1",
  "cmdstat_config|get:calls=2,usec=18,usec_per_call=9.00,rejected_calls=0,failed_calls=0",
  "cmdstat_script|flush:calls=1,usec=5,usec_per_call=5.00,rejected_calls=0,failed_calls=1",
  "",
  "# Keyspace",
  "db0:keys=12,expires=12,avg_ttl=0",
  "db2:keys=3,expires=0,avg_ttl=0",
  "",
].join("\r\n");

describe("summarizeChanges", () => {
  const summary = summarizeChanges(parseInfo(FLUSHED_VALKEY_INFO));

  it("dates the restart from the uptime and says how many keys it started with", () => {
    expect(summary.changes[0]).toEqual({
      at_ago_s: 7_200,
      kind: "restart",
      change: "server started (a restart or new instance): every connection was dropped; 15230 keys loaded",
    });
  });

  it("reports a promotion, undated, from the previous replication ID", () => {
    expect(summary.changes[1]).toEqual({
      at_ago_s: null,
      kind: "promotion",
      change: "this server was a replica and became the primary",
    });
  });

  it("lists the admin commands that succeeded, as typed, and counts keys in every database", () => {
    expect(summary.admin_commands).toEqual([
      { command: "FLUSHALL", runs: 1, effect: "deleted every key in every database" },
      {
        command: "CONFIG SET",
        runs: 2,
        effect: "changed settings at runtime (values not shown; redis_health shows the memory settings)",
      },
    ]);
    expect(summary.keys).toBe(15);
    expect(summary).toMatchObject({ server: "valkey", admin_commands_since: "the server started 2 hours ago" });
  });

  it("says the cache started empty when nothing was loaded from disk", () => {
    const [restart] = summarizeChanges(parseInfo("uptime_in_seconds:40\nrdb_last_load_keys_loaded:0")).changes;
    expect(restart?.change).toContain("nothing was loaded from disk, so the cache started empty");
  });

  it("reports a replica's new primary and its lost link, dated", () => {
    const replica = [
      "uptime_in_seconds:86400",
      "role:slave",
      "master_link_status:down",
      "master_link_down_since_seconds:95",
      "master_replid2:c268329896fa81bf1b4a7243501d3e981b7b4811",
    ].join("\n");
    expect(summarizeChanges(parseInfo(replica)).changes.map((change) => [change.kind, change.at_ago_s])).toEqual([
      ["restart", 86_400],
      ["primary_changed", null],
      ["primary_link_down", 95],
    ]);
  });

  it("reports no failover for a server that was never a replica, nor a link that never came up", () => {
    const fresh = [
      "uptime_in_seconds:30",
      "role:slave",
      "master_link_status:down",
      "master_link_down_since_seconds:-1",
      "master_replid2:0000000000000000000000000000000000000000",
    ].join("\n");
    expect(summarizeChanges(parseInfo(fresh)).changes.map((change) => change.kind)).toEqual(["restart"]);
  });

  it("says when the counts start at a CONFIG RESETSTAT instead of the start", () => {
    const reset = parseInfo("uptime_in_seconds:600\ncmdstat_config|resetstat:calls=1,failed_calls=0");
    expect(summarizeChanges(reset).admin_commands_since).toBe(
      "CONFIG RESETSTAT, at an unrecorded time after the server started 10 minutes ago",
    );
  });
});

describe("adminRuns", () => {
  it("ignores application commands and unknown fields", () => {
    const info = parseInfo("cmdstat_set:calls=5,failed_calls=0\ncmdstat_hasOwnProperty:calls=1\nflushall:calls=1");
    expect(adminRuns(info)).toEqual([]);
  });
});

describe("redis_changes (unit)", () => {
  it("asks only for INFO", async () => {
    const redis = fakeRedis({ INFO: FLUSHED_VALKEY_INFO });
    const h = await harness({ tools: [redisChanges], redis: redis.client });
    const res = await h.call("redis_changes");
    expect(res.isError, res.text).toBe(false);
    expect(redis.sent).toEqual([["INFO", "server", "persistence", "replication", "keyspace", "commandstats"]]);
    expect(res.json.admin_commands[0].command).toBe("FLUSHALL");
  });
});
