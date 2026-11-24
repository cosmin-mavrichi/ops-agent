import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { connectServer, WRITE_SERVER_NAME } from "../../src/mcp.js";

const NAMED_SERVER = fileURLToPath(new URL("../fixtures/named-server.mjs", import.meta.url));

describe("connectServer", () => {
  it("refuses the write server, and reports it as refused rather than as a server that exited", async () => {
    const onClose = vi.fn();
    const env = { SERVER_NAME: WRITE_SERVER_NAME };
    await expect(connectServer(NAMED_SERVER, env, onClose)).rejects.toThrow(/write server/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("connects to any other server", async () => {
    const onClose = vi.fn();
    const server = await connectServer(NAMED_SERVER, { SERVER_NAME: "ops" }, onClose);
    await server.close();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
