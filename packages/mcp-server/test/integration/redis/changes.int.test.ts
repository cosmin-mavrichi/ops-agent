import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClient } from "../../../src/adapters/redis.js";
import { redisChanges } from "../../../src/tools/redis/changes.js";
import { type Harness, startHarness } from "../../harness.js";
import { ADMIN_PW, type Flavor, OPS_REDIS_PW, type RedisFixture, startRedis } from "./redis-fixture.js";

const SESSION_TOKEN = "71bd0c55e2a94f6fflushplanted";
const SESSION_VALUE = '{"card_token":"tok_planted_flush_3307"}';
// Set with CONFIG SET: the tool reports that settings changed, never their values.
const PRIMARY_PASSWORD = "masterauth-planted-9914";

describe.each<Flavor>(["valkey", "redis"])("redis_changes against %s", (flavor) => {
  let redis: RedisFixture;
  let h: Harness;
  const outputs: string[] = [];

  beforeAll(async () => {
    redis = await startRedis(flavor);
    const app = await redis.connectApp("checkout");
    await app.set(`session:${SESSION_TOKEN}`, SESSION_VALUE);
    await app.set("product:42", "lamp");

    // The incident: someone runs a cleanup script against the production cache.
    await redis.admin.configSet("masterauth", PRIMARY_PASSWORD);
    await redis.admin.flushAll();
    await app.set("product:42", "lamp");

    const client = createRedisClient({ url: redis.opsUrl, onError: () => {} });
    h = await startHarness({ tools: [redisChanges], redis: client, knownSecrets: [OPS_REDIS_PW] });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await redis?.stop();
  });

  it("shows the flush and the settings change, as ops_ro, with the restart dated", async () => {
    const res = await h.call("redis_changes");
    outputs.push(res.text);
    expect(res.isError, res.text).toBe(false);
    expect(res.json.server).toBe(flavor);
    expect(res.json.keys).toBe(1);
    expect(res.json.admin_commands).toContainEqual(expect.objectContaining({ command: "FLUSHALL", runs: 1 }));
    expect(res.json.admin_commands).toContainEqual(expect.objectContaining({ command: "CONFIG SET", runs: 1 }));
    expect(res.json.changes).toEqual([expect.objectContaining({ kind: "restart", at_ago_s: expect.any(Number) })]);
    expect(res.json.changes[0].change).toContain("the cache started empty");
    expect(res.json.admin_commands_since).toMatch(/^the server started \d+ seconds? ago$/);
  });

  it("reports a promotion after the server stops replicating", async () => {
    // A primary that does not exist: the server becomes a replica, then is promoted back.
    await redis.admin.sendCommand(["REPLICAOF", "127.0.0.1", "1"]);
    await redis.admin.sendCommand(["REPLICAOF", "NO", "ONE"]);

    const res = await h.call("redis_changes");
    outputs.push(res.text);
    expect(res.json.changes.map((change: { kind: string }) => change.kind)).toEqual(["restart", "promotion"]);
    const commands = res.json.admin_commands.map((run: { command: string }) => run.command);
    expect(commands).toContain("REPLICAOF");
  });

  it("never leaks a planted secret", () => {
    expect(outputs).toHaveLength(2);
    const secrets = [SESSION_TOKEN, SESSION_VALUE, "tok_planted_flush_3307", PRIMARY_PASSWORD, OPS_REDIS_PW, ADMIN_PW];
    for (const secret of secrets) {
      for (const output of outputs) expect(output).not.toContain(secret);
    }
  });
});
