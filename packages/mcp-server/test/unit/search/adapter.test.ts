import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSearchClient, isAllowedPath } from "../../../src/adapters/search.js";
import { ToolError } from "../../../src/types.js";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(status: number, body: string) {
  const received: Received[] = [];
  server = createServer((req, res) => {
    received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `127.0.0.1:${port}`, received };
}

describe("isAllowedPath", () => {
  it.each([
    "/products/_search",
    "/_all/_search",
    "/products/_doc/1",
    "/_cat/indices",
    "/_security/user",
    "/_cluster/state",
    "/_all/_settings",
    "/_nodes/stats",
  ])("refuses %s", (path) => {
    expect(isAllowedPath(path)).toBe(false);
  });
});

describe("createSearchClient", () => {
  it("sends a GET with basic auth from the URL and the query", async () => {
    const { base, received } = await serve(200, '{"status":"green"}');
    const search = createSearchClient({ url: `http://ops_ro:p%40ss@${base}` });
    expect(await search.getJson("/_cluster/health", { level: "cluster" })).toEqual({ status: "green" });
    expect(received[0]).toMatchObject({ method: "GET", url: "/_cluster/health?level=cluster" });
    expect(received[0]?.headers.authorization).toBe(`Basic ${Buffer.from("ops_ro:p@ss").toString("base64")}`);
  });

  it("refuses a path outside the allowlist before sending anything", async () => {
    const { base, received } = await serve(200, "{}");
    await expect(createSearchClient({ url: `http://${base}` }).getJson("/products/_search")).rejects.toThrow(
      "not allowed",
    );
    expect(received).toEqual([]);
  });

  it("maps refused credentials to forbidden", async () => {
    const { base } = await serve(403, '{"error":"no permissions"}');
    const err = await createSearchClient({ url: `http://${base}` })
      .getJson("/")
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "forbidden" });
  });

  it("says the cluster is unreachable without naming it", async () => {
    const search = createSearchClient({ url: "http://127.0.0.1:1", timeoutMs: 1_000 });
    const err = await search.getJson("/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).not.toContain("127.0.0.1");
  });

  it("keeps other failures internal", async () => {
    const { base } = await serve(500, "boom");
    const err = await createSearchClient({ url: `http://${base}` })
      .getJson("/")
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ToolError);
  });
});
