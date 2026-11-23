import { describe, expect, it } from "vitest";
import { byCommand, parseSlowlog, problemsOf, redisSlowlog } from "../../../src/tools/redis/slowlog.js";
import { useHarness } from "../../harness.js";
import { fakeRedis, NOW, unixAgo } from "./fake-redis.js";

const harness = useHarness();

const SESSION_TOKEN = "9f2c41aa7b3e40d1planted";
const CARD_TOKEN = "tok_planted_card_7731";

// [id, unix time, duration µs, args, client address, client name]
const SLOWLOG = [
  [12, unixAgo(5), 48_250, ["KEYS", "*"], "10.42.0.9:51234", "checkout"],
  [11, unixAgo(30), 15_100, ["SET", `session:${SESSION_TOKEN}`, `{"card":"${CARD_TOKEN}"}`], "10.42.0.9:51236", ""],
  [10, unixAgo(60), 12_000, ["CONFIG", "SET", "maxmemory", "2mb"], "10.42.0.3:39000", "admin"],
  [9, unixAgo(90), 30_000, ["KEYS", "session:*"], "10.42.0.9:51234", "checkout"],
];

describe("parseSlowlog", () => {
  const entries = parseSlowlog(SLOWLOG, NOW);

  it("keeps the command, the masked key shape and timing, never the arguments", () => {
    expect(entries[1]).toEqual({
      command: "SET",
      key_shape: "session:?",
      arg_count: 2,
      duration_ms: 15.1,
      ago_s: 30,
      client_name: null,
    });
    const text = JSON.stringify(entries);
    expect(text).not.toContain(SESSION_TOKEN);
    expect(text).not.toContain(CARD_TOKEN);
  });

  it("names the subcommand of container commands", () => {
    expect(entries[2]).toMatchObject({ command: "CONFIG SET", key_shape: "maxmemory" });
  });

  it("rejects replies that don't have the slowlog shape", () => {
    expect(() => parseSlowlog([["not", "an", "entry"]], NOW)).toThrow();
  });
});

describe("byCommand", () => {
  it("totals per command, costliest first", () => {
    expect(byCommand(parseSlowlog(SLOWLOG, NOW))[0]).toEqual({
      command: "KEYS",
      count: 2,
      total_ms: 78.3,
      max_ms: 48.3,
    });
  });
});

describe("problemsOf", () => {
  it("spells out whole-collection reads with their clients and replacement, and nothing else", () => {
    const entries = parseSlowlog(
      [...SLOWLOG, [8, unixAgo(100), 4_400, ["HGETALL", "report:2026"], "10.42.0.7:40000", "reports"]],
      NOW,
    );
    expect(problemsOf(byCommand(entries), entries)).toEqual([
      "KEYS from checkout (2 slow calls, up to 48.3 ms) reads the whole keyspace in one call: every other client " +
        "waits while it runs, and it gets slower as the data grows. Use SCAN instead.",
      "HGETALL from reports (1 slow call, up to 4.4 ms) reads the whole hash in one call: every other client " +
        "waits while it runs, and it gets slower as the data grows. Use HSCAN instead.",
    ]);
  });
});

describe("redis_slowlog (unit)", () => {
  it("returns the summary without leaking argument values", async () => {
    const redis = fakeRedis({ "SLOWLOG GET": SLOWLOG, "SLOWLOG LEN": 4 });
    const h = await harness({ tools: [redisSlowlog], redis: redis.client });
    const res = await h.call("redis_slowlog", { limit: 10 });
    expect(res.json.logged_total).toBe(4);
    expect(res.json.by_command[0].command).toBe("KEYS");
    expect(redis.sent).toContainEqual(["SLOWLOG", "GET", "10"]);
    expect(res.text).not.toContain(SESSION_TOKEN);
    expect(res.text).not.toContain(CARD_TOKEN);
  });
});
