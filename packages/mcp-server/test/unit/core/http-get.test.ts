import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type GetOptions, httpGet, httpPatch } from "../../../src/lib/http-get.js";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** A local server whose handler decides how to (mis)behave; returns its URL and the headers it saw. */
async function serve(handler: (res: ServerResponse) => void) {
  const seen: IncomingHttpHeaders[] = [];
  const requests: Array<{ method?: string; body: string }> = [];
  server = createServer(async (req, res) => {
    seen.push(req.headers);
    requests.push({ method: req.method, body: await req.reduce((text: string, chunk: Buffer) => text + chunk, "") });
    handler(res);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: new URL(`http://127.0.0.1:${port}/path?x=1`), seen, requests };
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

  it("sends GET without a body", async () => {
    const { url, requests } = await serve((res) => res.end("ok"));
    await httpGet(url, options());
    expect(requests[0]).toEqual({ method: "GET", body: "" });
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

describe("httpPatch", () => {
  it("sends PATCH with the body and its content type", async () => {
    const { url, seen, requests } = await serve((res) => res.writeHead(200).end("{}"));
    const patch = options({ maxBytes: 100 });
    const sent = await httpPatch(url, { ...patch, body: '{"a":1}', contentType: "application/merge-patch+json" });
    expect(sent).toEqual({ status: 200, body: "{}" });
    expect(requests[0]).toEqual({ method: "PATCH", body: '{"a":1}' });
    expect(seen[0]?.["content-type"]).toBe("application/merge-patch+json");
  });

  it("keeps httpGet's size cap", async () => {
    const { url } = await serve((res) => res.end("x".repeat(5_000)));
    const patch = { ...options({ maxBytes: 100 }), body: "{}", contentType: "application/json" };
    await expect(httpPatch(url, patch)).rejects.toThrow("test /path: response over 100 bytes");
  });
});
