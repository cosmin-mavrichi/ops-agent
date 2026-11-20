import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClient } from "../../../src/adapters/redis.js";
import { redisHealth } from "../../../src/tools/redis/health.js";
import { redisSlowlog } from "../../../src/tools/redis/slowlog.js";
import { type Harness, startHarness } from "../../harness.js";
import {
  ADMIN_PW,
  type Connection,
  type Flavor,
  OPS_REDIS_PW,
  type RedisFixture,
  startRedis,
} from "./redis-fixture.js";

const SESSION_TOKEN = "9f2c41aa7b3e40d1redisplanted";
const SESSION_VALUE = '{"card_token":"tok_planted_redis_8812"}';
// Large enough that a few writes fill the cache, so the planted session write stays among the listed entries.
const BLOB = "x".repeat(400_000);

/** Writes until the server refuses with OOM, then a few more times so the refusals are counted. */
async function fillUntilOom(app: Connection): Promise<void> {
  let refused = 0;
  for (let i = 0; i < 500 && refused < 3; i++) {
    try {
      await app.set(`blob:${i}`, BLOB);
    } catch (err) {
      if (!String(err).includes("OOM")) throw err;
      refused++;
    }
  }
  if (refused < 3) throw new Error("never ran out of memory");
}

describe.each<Flavor>(["valkey", "redis"])("%s", (flavor) => {
  let redis: RedisFixture;
  let h: Harness;
  const outputs: string[] = [];

  beforeAll(async () => {
    redis = await startRedis(flavor);
    // The incident: a cache capped at 2 MB that refuses writes instead of evicting.
    await redis.admin.configSet({ maxmemory: "2mb", "maxmemory-policy": "noeviction", "slowlog-log-slower-than": "0" });

    const app = await redis.connectApp("checkout");
    await app.set(`session:${SESSION_TOKEN}`, SESSION_VALUE);
    await fillUntilOom(app);

    const client = createRedisClient({ url: redis.opsUrl, onError: () => {} });
    h = await startHarness({ tools: [redisHealth, redisSlowlog], redis: client, knownSecrets: [OPS_REDIS_PW] });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await redis?.stop();
  });

  it("redis_health shows a full cache refusing writes, from the ops_ro user", async () => {
    const res = await h.call("redis_health");
    outputs.push(res.text);
    expect(res.isError).toBe(false);
    expect(res.json.server).toBe(flavor);
    expect(res.json.memory).toMatchObject({ max_mb: 2, policy: "noeviction" });
    expect(res.json.memory.used_pct).toBeGreaterThanOrEqual(90);
    expect(res.json.errors.by_type.OOM).toBeGreaterThanOrEqual(3);
    expect(res.json.warnings.join("\n")).toContain("writes fail with OOM");
    expect(res.json.clients.top.map((c: { name: string }) => c.name)).toContain("checkout");
    expect(res.json.clients.top.map((c: { name: string }) => c.name)).not.toContain("ops-mcp");
  });

  it("redis_slowlog shows command shapes, never keys' secrets or values", async () => {
    const res = await h.call("redis_slowlog", { limit: 128 });
    outputs.push(res.text);
    expect(res.isError).toBe(false);
    const shapes = res.json.entries.map((e: { command: string; key_shape: string }) => `${e.command} ${e.key_shape}`);
    expect(shapes).toContain("SET blob:?");
    // The write that carries the planted token is listed, so the leak check below really sees it.
    expect(shapes).toContain("SET session:?");
  });

  it("never leaks a planted secret", () => {
    expect(outputs).toHaveLength(2);
    for (const secret of [SESSION_TOKEN, SESSION_VALUE, "tok_planted_redis_8812", OPS_REDIS_PW, ADMIN_PW]) {
      for (const output of outputs) expect(output).not.toContain(secret);
    }
  });

  describe("the ops_ro ACL user alone (no adapter) is read-only and keyless", () => {
    it.each([
      [["GET", `session:${SESSION_TOKEN}`]],
      [["SET", "x", "1"]],
      [["KEYS", "*"]],
      [["SCAN", "0"]],
      [["CONFIG", "GET", "requirepass"]],
      [["ACL", "LIST"]],
      [["CLIENT", "KILL", "ID", "1"]],
      [["SLOWLOG", "RESET"]],
      [["FLUSHALL"]],
      [["EVAL", "return redis.call('GET', KEYS[1])", "1", `session:${SESSION_TOKEN}`]],
      [["MONITOR"]],
      [["BGSAVE"]],
    ])("refuses %j", async (command) => {
      const ops = await redis.connectOps();
      await expect(ops.sendCommand(command)).rejects.toThrow(/NOPERM/);
    });

    it("can read INFO, SLOWLOG and CLIENT LIST", async () => {
      const ops = await redis.connectOps();
      await expect(ops.sendCommand(["INFO", "memory"])).resolves.toContain("used_memory");
      await expect(ops.sendCommand(["SLOWLOG", "LEN"])).resolves.toEqual(expect.any(Number));
      await expect(ops.sendCommand(["CLIENT", "LIST"])).resolves.toContain("name=checkout");
    });
  });
});
