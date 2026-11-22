import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPromClient, parseVector } from "../../../src/adapters/prometheus.js";
import { ToolError } from "../../../src/types.js";

const VECTOR = JSON.stringify({
  status: "success",
  data: { resultType: "vector", result: [{ metric: { namespace: "app" }, value: [1_790_000_000, "42.5"] }] },
});

interface Received {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

let server: Server | undefined;
afterEach(() => server?.close());

/** A local HTTP server answering every request with `status` and `body`; records what it received. */
async function serve(status: number, body: string) {
  const received: Received[] = [];
  server = createServer((req, res) => {
    received.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `127.0.0.1:${port}`, received };
}

describe("createPromClient", () => {
  it("sends one instant query and returns labels with numeric values", async () => {
    const { base, received } = await serve(200, VECTOR);
    const prom = createPromClient({ url: `http://${base}` });
    const samples = await prom.query('up{job="kubelet"}');
    expect(samples).toEqual([{ labels: { namespace: "app" }, value: 42.5 }]);
    expect(received[0]?.url).toBe(`/api/v1/query?query=${encodeURIComponent('up{job="kubelet"}')}`);
  });

  it("keeps a path prefix (Mimir and proxies serve the API under one)", async () => {
    const { base, received } = await serve(200, VECTOR);
    await createPromClient({ url: `http://${base}/prometheus` }).query("up");
    expect(received[0]?.url).toMatch(/^\/prometheus\/api\/v1\/query\?/);
  });

  it("sends basic auth from the URL as a header", async () => {
    const { base, received } = await serve(200, VECTOR);
    await createPromClient({ url: `http://ops:s3cr%40t@${base}` }).query("up");
    const expected = `Basic ${Buffer.from("ops:s3cr@t").toString("base64")}`;
    expect(received[0]?.headers.authorization).toBe(expected);
  });

  it("says the server is unreachable without naming it", async () => {
    const prom = createPromClient({ url: "http://127.0.0.1:1", timeoutMs: 1_000 });
    const err = await prom.query("up").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("unavailable");
    expect((err as ToolError).message).not.toContain("127.0.0.1");
  });

  it("refuses responses over the size cap", async () => {
    const { base } = await serve(200, VECTOR);
    const prom = createPromClient({ url: `http://${base}`, maxResponseBytes: 10 });
    await expect(prom.query("up")).rejects.toThrow(/over 10 bytes/);
  });
});

describe("parseVector", () => {
  it("maps refused credentials to a forbidden ToolError", () => {
    expect(() => parseVector(401, "Unauthorized")).toThrow(ToolError);
  });

  it("keeps a failed query internal: a plain Error, which the model only sees as internal_error", () => {
    const body = JSON.stringify({ status: "error", errorType: "bad_data", error: "parse error at char 3" });
    expect(() => parseVector(400, body)).toThrow(/^prometheus query failed \(400\): parse error/);
  });

  it("refuses anything but an instant vector", () => {
    const matrix = JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } });
    expect(() => parseVector(200, matrix)).toThrow(/expected a vector/);
  });
});
