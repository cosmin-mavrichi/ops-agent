import { describe, expect, it } from "vitest";
import { maskKey, parseInfo, parsePairs } from "../../../src/tools/redis/shared.js";

describe("parseInfo", () => {
  it("reads field:value lines and skips section headers and blanks", () => {
    const info = parseInfo("# Server\r\nredis_version:7.4.1\r\n\r\n# Memory\r\nused_memory:1024\r\n");
    expect([...info]).toEqual([
      ["redis_version", "7.4.1"],
      ["used_memory", "1024"],
    ]);
  });

  it("keeps colons inside values", () => {
    expect(parseInfo("executable:/usr/bin/valkey-server\nrun_id:a:b").get("run_id")).toBe("a:b");
  });
});

describe("parsePairs", () => {
  it("reads key=value lists with the given separator", () => {
    expect(parsePairs("keys=12,expires=3", ",").get("expires")).toBe("3");
    expect(parsePairs("id=3 name= user=app", " ").get("name")).toBe("");
  });
});

describe("maskKey", () => {
  it.each([
    ["session:9f2c41aa7b", "session:?"],
    ["user:42:profile", "user:?:profile"],
    ["cache:orders", "cache:orders"],
    ["email:maria.pop@example.ro", "email:?"],
    ["token:QXJhbmRvbWxldHRlcnNvbmx5dG9rZW4", "token:?"],
    ["return redis.call('GET', KEYS[1])", "?"],
    ["*", "?"],
  ])("%s -> %s", (key, masked) => {
    expect(maskKey(key)).toBe(masked);
  });
});
