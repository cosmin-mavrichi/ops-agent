import { describe, expect, it } from "vitest";
import { createRedisClient, isAllowedCommand } from "../../../src/adapters/redis.js";

describe("isAllowedCommand", () => {
  it.each([[["INFO"]], [["info", "memory"]], [["SLOWLOG", "GET", "25"]], [["CLIENT", "LIST"]], [["PING"]]])(
    "allows %j",
    (command) => expect(isAllowedCommand(command)).toBe(true),
  );

  it.each([
    [["GET", "session:1"]],
    [["CONFIG", "GET", "requirepass"]],
    [["CLIENT", "KILL", "ID", "3"]],
    [["SLOWLOG", "RESET"]],
    [["FLUSHALL"]],
    [["EVAL", "return 1", "0"]],
    [[]],
  ])("refuses %j", (command) => expect(isAllowedCommand(command)).toBe(false));
});

describe("createRedisClient", () => {
  it("refuses a command outside the allowlist before connecting", async () => {
    const errors: Error[] = [];
    // Nothing listens on port 1: a connection attempt would fail differently and report an error.
    const client = createRedisClient({ url: "redis://127.0.0.1:1", onError: (err) => errors.push(err) });
    await expect(client.send(["CONFIG", "GET", "requirepass"])).rejects.toThrow("redis command not allowed: CONFIG");
    expect(errors).toEqual([]);
  });
});
