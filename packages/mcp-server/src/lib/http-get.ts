import { type ClientRequest, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

export interface GetOptions {
  readonly headers: Readonly<Record<string, string>>;
  /** PEM CA bundle for a server whose certificate a public CA did not sign. */
  readonly ca?: string;
  /** How long the connection may stay silent before the request fails. */
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  /** Names the request in errors, e.g. "kubernetes /api/v1/pods". Never include credentials. */
  readonly label: string;
}

export interface GetResult {
  readonly status: number;
  readonly body: string;
}

interface Exchange {
  readonly req: ClientRequest;
  readonly res: IncomingMessage;
}

export interface PatchOptions extends GetOptions {
  readonly body: string;
  /** The patch format, e.g. application/strategic-merge-patch+json. */
  readonly contentType: string;
}

interface Payload {
  readonly body: string;
  readonly contentType: string;
}

/** One GET, the only method the read-only adapters send. Fails on silence, abort, early close or size. */
export function httpGet(url: URL, opts: GetOptions): Promise<GetResult> {
  return exchange(url, "GET", opts);
}

/** One PATCH, sent only by the write server's adapter (packages/mcp-write); same limits as httpGet. */
export function httpPatch(url: URL, opts: PatchOptions): Promise<GetResult> {
  return exchange(url, "PATCH", opts, { body: opts.body, contentType: opts.contentType });
}

async function exchange(url: URL, method: "GET" | "PATCH", opts: GetOptions, payload?: Payload): Promise<GetResult> {
  const contentType = payload ? { "content-type": payload.contentType } : {};
  const options: RequestOptions & { ca?: string } = {
    method,
    headers: { ...opts.headers, ...contentType },
    timeout: opts.timeoutMs,
    signal: opts.signal,
    ...(opts.ca ? { ca: opts.ca } : {}),
  };
  const { req, res } = await sendRequest(url, options, opts.label, payload?.body);
  const body = await readBody(req, res, opts.maxBytes, opts.label);
  return { status: res.statusCode ?? 0, body };
}

/** No response at all: refused, unresolvable, or silent until the timeout. Adapters report it as unavailable. */
export class ConnectionError extends Error {
  constructor(label: string, cause: unknown) {
    super(`${label}: no response (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
  }
}

/** Resolves once the response headers arrive. */
function sendRequest(url: URL, options: RequestOptions, label: string, body?: string): Promise<Exchange> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => resolve({ req, res }));
    req.on("timeout", () => req.destroy(new Error(`${label}: request timed out`)));
    // Once the response has arrived the promise is settled, and readBody reports later errors.
    req.on("error", (err) => reject(new ConnectionError(label, err)));
    req.end(body);
  });
}

/** Reads the whole body, failing past maxBytes or when the connection drops before the end. */
function readBody(req: ClientRequest, res: IncomingMessage, maxBytes: number, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // A timeout or abort mid-body is reported on the request; the response only sees "aborted".
    req.on("error", reject);
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) res.destroy(new Error(`${label}: response over ${maxBytes} bytes`));
      else chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
    // Timeouts and aborts destroy the request; the response then closes without "end".
    res.on("close", () => {
      if (!res.complete) reject(new Error(`${label}: response ended early`));
    });
  });
}
