import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { Level } from "../../src/types.js";

const PG_URL = "postgres://ops_ro:pg-pass-7781@db:5432/app";

describe("loadConfig", () => {
  it("defaults to read-only", () => {
    expect(loadConfig({ OPS_PG_URL: PG_URL }).maxLevel).toBe(Level.Read);
  });

  it.each(["2", "3"])("refuses to boot with OPS_MAX_LEVEL=%s in v1", (level) => {
    expect(() => loadConfig({ OPS_PG_URL: PG_URL, OPS_MAX_LEVEL: level })).toThrow(/not supported in v1/);
  });

  it.each(["0", "4", "abc"])("rejects invalid OPS_MAX_LEVEL=%s", (level) => {
    expect(() => loadConfig({ OPS_PG_URL: PG_URL, OPS_MAX_LEVEL: level })).toThrow();
  });

  it("requires a valid OPS_PG_URL", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ OPS_PG_URL: "not a url" })).toThrow();
  });

  it("scrubs the database password even if nobody listed it", () => {
    expect(loadConfig({ OPS_PG_URL: PG_URL }).knownSecrets).toContain("pg-pass-7781");
  });

  it("decodes a URL-encoded password before scrubbing it", () => {
    const cfg = loadConfig({ OPS_PG_URL: "postgres://ops_ro:p%40ss%2Fword@db/app" });
    expect(cfg.knownSecrets).toContain("p@ss/word");
  });

  it("trims known secrets and drops empty entries", () => {
    const cfg = loadConfig({ OPS_PG_URL: "postgres://db/app", OPS_KNOWN_SECRETS: " key-one ,, key-two ," });
    expect(cfg.knownSecrets).toEqual(["key-one", "key-two"]);
  });
});
