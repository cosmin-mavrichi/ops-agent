import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ToolError } from "@ops-agent/mcp-server/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  createK8sWriteClient,
  type DeploymentRestart,
  RESTARTED_AT,
  statusError,
} from "../../src/adapters/k8s-write.js";

interface Seen {
  readonly method?: string;
  readonly url?: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** A stand-in API server over plain HTTP, recording every request it gets. */
async function apiServer(respond: (res: ServerResponse) => void = (res) => res.end("{}")) {
  const seen: Seen[] = [];
  server = createServer(async (req, res) => {
    const body = await req.reduce((text: string, chunk: Buffer) => text + chunk, "");
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    respond(res);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = createK8sWriteClient({
    server: `http://127.0.0.1:${port}`,
    ca: "",
    token: () => "session-token",
    namespaces: ["app"],
  });
  return { client, seen };
}

const RESTART: DeploymentRestart = {
  namespace: "app",
  name: "api",
  resourceVersion: "4711",
  restartedAt: "2026-11-24T12:00:00Z",
  mode: "apply",
};

describe("the write adapter", () => {
  it("reads deployments and pods in its namespaces", async () => {
    const { client, seen } = await apiServer();
    await client.getJson("/apis/apps/v1/namespaces/app/deployments/api");
    await client.getJson("/apis/apps/v1/namespaces/app/deployments");
    await client.getJson("/api/v1/namespaces/app/pods", undefined, { labelSelector: "app=api" });
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /apis/apps/v1/namespaces/app/deployments/api",
      "GET /apis/apps/v1/namespaces/app/deployments",
      "GET /api/v1/namespaces/app/pods?labelSelector=app%3Dapi",
    ]);
    expect(seen[0]?.headers.authorization).toBe("Bearer session-token");
  });

  it.each([
    "/api/v1/namespaces/app/secrets",
    "/api/v1/namespaces/app/pods/api-1/log",
    "/api/v1/namespaces/app/configmaps",
    "/apis/apps/v1/namespaces/app/deployments/api/scale",
    "/apis/apps/v1/namespaces/app/deployments/../../../../api/v1/secrets",
  ])("refuses to read %s before sending anything", async (path) => {
    const { client, seen } = await apiServer();
    await expect(client.getJson(path)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("refuses namespaces outside its list, for reads and for the restart", async () => {
    const { client, seen } = await apiServer();
    await expect(client.getJson("/apis/apps/v1/namespaces/kube-system/deployments")).rejects.toThrow(ToolError);
    await expect(client.restartDeployment({ ...RESTART, namespace: "kube-system" })).rejects.toThrow(ToolError);
    expect(seen).toEqual([]);
  });

  it("refuses a deployment name that is not a Kubernetes name", async () => {
    const { client, seen } = await apiServer();
    await expect(client.restartDeployment({ ...RESTART, name: "api/scale" })).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("restarts with the restartedAt annotation, the resourceVersion as precondition, and nothing else", async () => {
    const { client, seen } = await apiServer();
    await client.restartDeployment(RESTART);
    expect(seen[0]).toMatchObject({
      method: "PATCH",
      url: "/apis/apps/v1/namespaces/app/deployments/api?fieldManager=ops-write",
    });
    expect(seen[0]?.headers["content-type"]).toBe("application/strategic-merge-patch+json");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      metadata: { resourceVersion: "4711" },
      spec: { template: { metadata: { annotations: { [RESTARTED_AT]: "2026-11-24T12:00:00Z" } } } },
    });
  });

  it("sends the same patch as a server-side dry run", async () => {
    const { client, seen } = await apiServer();
    await client.restartDeployment({ ...RESTART, mode: "dry_run" });
    expect(seen[0]?.url).toBe("/apis/apps/v1/namespaces/app/deployments/api?fieldManager=ops-write&dryRun=All");
  });

  it("reports a changed deployment as a conflict the agent can act on", async () => {
    const { client } = await apiServer((res) => res.writeHead(409).end(JSON.stringify({ message: "conflict" })));
    await expect(client.restartDeployment(RESTART)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("statusError", () => {
  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "invalid_request"],
  ])("maps %i to ToolError %s", (status, code) => {
    expect(statusError(status, "/x", "{}")).toMatchObject({ code });
  });

  it("keeps other failures internal", () => {
    expect(statusError(500, "/x", "boom")).not.toBeInstanceOf(ToolError);
  });
});
