import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type GetOptions, httpGet } from "../../../src/lib/http-get.js";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** A local server whose handler decides how to (mis)behave; returns its URL and the headers it saw. */
async function serve(handler: (res: ServerResponse) => void) {
  const seen: IncomingHttpHeaders[] = [];
  server = createServer((req, res) => {
    seen.push(req.headers);
    handler(res);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: new URL(`http://127.0.0.1:${port}/path?x=1`), seen };
}

const options = (overrides: Partial<GetOptions> = {}): GetOptions => ({
  headers: { accept: "application/json" },
  timeoutMs: 2_000,
  maxBytes: 1_000,
  label: "test /path",
  ...overrides,
});

describe("httpGet", () => {
  it("returns status and body, sending only GET with the given headers", async () => {
    const { url, seen } = await serve((res) => res.writeHead(404).end("missing"));
    expect(await httpGet(url, options({ headers: { authorization: "Basic eA==" } }))).toEqual({
      status: 404,
      body: "missing",
    });
    expect(seen[0]?.authorization).toBe("Basic eA==");
  });

  it("refuses a body over the size cap", async () => {
    const { url } = await serve((res) => res.end("x".repeat(5_000)));
    await expect(httpGet(url, options({ maxBytes: 100 }))).rejects.toThrow("test /path: response over 100 bytes");
  });

  it("gives up on a server that goes quiet mid-response", async () => {
    const { url } = await serve((res) => res.writeHead(200).write("partial"));
    await expect(httpGet(url, options({ timeoutMs: 200 }))).rejects.toThrow(/timed out|ended early/);
  });

  it("stops when the caller aborts, even mid-response", async () => {
    const { url } = await serve((res) => res.writeHead(200).write("partial"));
    await expect(httpGet(url, options({ signal: AbortSignal.timeout(200) }))).rejects.toThrow();
  });

  it("fails when the server closes before the end of the body", async () => {
    const { url } = await serve((res) => {
      res.writeHead(200, { "content-length": "100" }).write("short");
      res.socket?.destroy();
    });
    await expect(httpGet(url, options())).rejects.toThrow();
  });
});
