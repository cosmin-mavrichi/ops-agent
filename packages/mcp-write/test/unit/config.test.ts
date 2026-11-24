import { Level } from "@ops-agent/mcp-server/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const ENV = {
  OPS_K8S_NAMESPACES: "app, jobs",
  OPS_K8S_SERVER: "https://127.0.0.1:6443",
  OPS_K8S_TOKEN_FILE: "/tmp/ops-write.token",
  OPS_K8S_CA_FILE: "/tmp/ca.crt",
};

describe("loadConfig", () => {
  it("boots at Level.Change with the namespaces as a list", () => {
    expect(loadConfig(ENV)).toMatchObject({
      maxLevel: Level.Change,
      k8s: { server: ENV.OPS_K8S_SERVER, namespaces: ["app", "jobs"] },
      knownSecrets: [],
    });
  });

  it("refuses Level.Dangerous until a dangerous tool exists", () => {
    expect(() => loadConfig({ ...ENV, OPS_MAX_LEVEL: "3" })).toThrow(/not supported/);
  });

  it("needs the namespaces, an explicit API server and a token file: it never falls back to a pod's identity", () => {
    const { OPS_K8S_SERVER: _server, ...inCluster } = ENV;
    expect(() => loadConfig({ ...inCluster, KUBERNETES_SERVICE_HOST: "10.43.0.1" })).toThrow();
    expect(() => loadConfig({ ...ENV, OPS_K8S_NAMESPACES: " , " })).toThrow(/OPS_K8S_NAMESPACES/);
    const { OPS_K8S_TOKEN_FILE: _token, ...noToken } = ENV;
    expect(() => loadConfig(noToken)).toThrow();
  });
});
