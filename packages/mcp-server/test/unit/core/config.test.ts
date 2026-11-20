import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { Level } from "../../../src/types.js";

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

describe("loadConfig: kubernetes", () => {
  const base = { OPS_PG_URL: PG_URL };

  it("leaves kubernetes off when no namespaces are listed", () => {
    expect(loadConfig({ ...base, KUBERNETES_SERVICE_HOST: "10.43.0.1" }).k8s).toBeUndefined();
  });

  it("uses the in-cluster API server and mounted ServiceAccount by default", () => {
    const cfg = loadConfig({ ...base, OPS_K8S_NAMESPACES: "app, jobs", KUBERNETES_SERVICE_HOST: "10.43.0.1" });
    expect(cfg.k8s).toEqual({
      server: "https://10.43.0.1:443",
      namespaces: ["app", "jobs"],
      tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    });
  });

  it("accepts an explicit server for running outside the cluster", () => {
    const cfg = loadConfig({ ...base, OPS_K8S_NAMESPACES: "app", OPS_K8S_SERVER: "https://k3s.local:6443" });
    expect(cfg.k8s?.server).toBe("https://k3s.local:6443");
  });

  it("refuses namespaces without any API server", () => {
    expect(() => loadConfig({ ...base, OPS_K8S_NAMESPACES: "app" })).toThrow(/no API server/);
  });
});

describe("loadConfig: redis", () => {
  const base = { OPS_PG_URL: PG_URL };

  it("leaves Redis off when no URL is set", () => {
    expect(loadConfig(base).redisUrl).toBeUndefined();
  });

  it("scrubs the Redis password along with the database one", () => {
    const cfg = loadConfig({ ...base, OPS_REDIS_URL: "redis://ops_ro:redis-pass-3391@cache:6379" });
    expect(cfg.redisUrl).toBe("redis://ops_ro:redis-pass-3391@cache:6379");
    expect(cfg.knownSecrets).toEqual(["pg-pass-7781", "redis-pass-3391"]);
  });

  it.each(["cache:6379", "http://cache:6379", "not a url"])("rejects %j as a Redis URL", (url) => {
    expect(() => loadConfig({ ...base, OPS_REDIS_URL: url })).toThrow();
  });

  it("accepts TLS URLs", () => {
    expect(loadConfig({ ...base, OPS_REDIS_URL: "rediss://ops_ro:pw-123456@cache:6380" }).redisUrl).toBeDefined();
  });
});
