import { describe, expect, it } from "vitest";
import { redisHealth, summarizeClients, summarizeHealth } from "../../../src/tools/redis/health.js";
import { parseInfo } from "../../../src/tools/redis/shared.js";
import { useHarness } from "../../harness.js";
import { CLIENT_LIST, FULL_VALKEY_INFO, fakeRedis, NOW } from "./fake-redis.js";

const harness = useHarness();

describe("summarizeHealth", () => {
  const health = summarizeHealth(parseInfo(FULL_VALKEY_INFO), CLIENT_LIST, NOW);

  it("reports Valkey's real version, not the redis_version it keeps for compatibility", () => {
    expect(health).toMatchObject({ server: "valkey", version: "9.0.1" });
  });

  it("reports memory against maxmemory and the eviction policy", () => {
    expect(health.memory).toEqual({
      used_mb: 1.9,
      max_mb: 2,
      used_pct: 97,
      policy: "noeviction",
      fragmentation_ratio: 1.12,
      evicted_keys: 0,
    });
  });

  it("explains the incident in warnings: full with noeviction, OOM rejections, failed snapshot", () => {
    expect(health.warnings).toEqual([
      "memory at 97% of maxmemory with policy noeviction: writes fail with OOM errors once it is full",
      "55 commands were rejected with OOM (out of memory) since start",
      "the last RDB snapshot failed",
    ]);
  });

  it("reads error counts, keyspace and persistence", () => {
    expect(health.errors).toEqual({ total: 57, by_type: { OOM: 55, WRONGTYPE: 2 } });
    expect(health.keyspace).toEqual({ db0: { keys: 1520, expires: 12 } });
    expect(health.persistence).toMatchObject({ rdb_last_save_ago_s: 7_200, rdb_last_bgsave_status: "err" });
    expect(health.stats.keyspace_hit_pct).toBe(90);
  });

  it("warns when there is no memory limit at all", () => {
    const unlimited = parseInfo("redis_version:8.2.0\nused_memory:1048576\nmaxmemory:0\nmaxmemory_policy:noeviction");
    const { memory, warnings, server } = summarizeHealth(unlimited, "", NOW);
    expect(server).toBe("redis");
    expect(memory).toMatchObject({ max_mb: null, used_pct: null });
    expect(warnings).toContain("no maxmemory limit: Redis grows until the container or node runs out of memory");
  });
});

describe("summarizeClients", () => {
  it("groups connections by name and user and leaves out the agent's own connection", () => {
    expect(summarizeClients(CLIENT_LIST)).toEqual([
      { name: "checkout", user: "app", connections: 2, max_idle_s: 12 },
      { name: "ioredis", user: "app", connections: 1, max_idle_s: 3 },
    ]);
  });
});

describe("redis_health (unit)", () => {
  it("asks only for INFO and CLIENT LIST", async () => {
    const redis = fakeRedis({ INFO: FULL_VALKEY_INFO, "CLIENT LIST": CLIENT_LIST });
    const h = await harness({ tools: [redisHealth], redis: redis.client });
    const res = await h.call("redis_health");
    expect(res.isError).toBe(false);
    expect(redis.sent.map((command) => command.slice(0, 2).join(" ")).sort()).toEqual(["CLIENT LIST", "INFO server"]);
  });
});
