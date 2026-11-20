import { ProtocolError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { allTools } from "../../src/tools/index.js";
import { Level, ToolError, defineTool, type ToolDef } from "../../src/types.js";
import { startHarness } from "../harness.js";

const echo = defineTool({
  name: "echo", level: Level.Read, title: "echo", description: "test",
  input: { msg: z.string().max(50) },
  run: async ({ msg }) => ({ msg }),
});
const restart = defineTool({
  name: "restart_service", level: Level.Change, title: "restart", description: "test",
  input: {}, run: async () => ({ restarted: true }),
});
const nuke = defineTool({
  name: "restore_backup", level: Level.Dangerous, title: "restore", description: "test",
  input: {}, run: async () => ({ restored: true }),
});

let h: Awaited<ReturnType<typeof startHarness>> | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe("level gating", () => {
  it("v1 exposes only level-1 tools", async () => {
    h = await startHarness({ tools: [echo, restart, nuke], maxLevel: Level.Read });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("a hidden tool cannot be called even by name", async () => {
    h = await startHarness({ tools: [echo, restart] });
    // MCP SDK v2 rejects unknown tools at the protocol level instead of returning an isError result.
    const err = await h.call("restart_service").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).message).toContain("not found");
    expect(h.audit).toHaveLength(0); // the handler never ran
  });

  it("marks read tools as readOnly in annotations", async () => {
    h = await startHarness({ tools: [echo] });
    const { tools } = await h.client.listTools();
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  /** Snapshot of the real v1 surface: adding a tool forces a deliberate snapshot update in review. */
  it("real v1 tool list", async () => {
    h = await startHarness({ tools: allTools });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toMatchInlineSnapshot(`
      [
        "pg_slow_queries",
      ]
    `);
    expect(allTools.every((t) => t.level === Level.Read)).toBe(true);
  });
});

describe("call pipeline", () => {
  it("rejects invalid and unknown arguments", async () => {
    h = await startHarness({ tools: [echo] });
    expect((await h.call("echo", { msg: "x".repeat(51) })).isError).toBe(true);
    expect((await h.call("echo", { msg: "hi", extra: "; rm -rf /" })).isError).toBe(true);
  });

  it("redacts secrets in results", async () => {
    h = await startHarness({ tools: [echo], knownSecrets: ["topsecretvalue"] });
    const res = await h.call("echo", { msg: "pw is topsecretvalue" });
    expect(res.text).not.toContain("topsecretvalue");
  });

  it("times out slow tools", async () => {
    const slow: ToolDef<any> = { ...echo, name: "slow", timeoutMs: 50, input: {}, run: () => new Promise((r) => setTimeout(r, 500)) };
    h = await startHarness({ tools: [slow] });
    const res = await h.call("slow");
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("timeout");
  });

  it("passes ToolError messages through, hides unexpected errors", async () => {
    const expected: ToolDef<any> = { ...echo, name: "expected", input: {}, run: async () => { throw new ToolError("unavailable", "extension missing"); } };
    const leaky: ToolDef<any> = { ...echo, name: "leaky", input: {}, run: async () => { throw new Error("connect ECONNREFUSED postgres://app:pw123456@10.0.0.5"); } };
    h = await startHarness({ tools: [expected, leaky] });

    expect((await h.call("expected")).json).toEqual({ error: "unavailable", message: "extension missing" });

    const res = await h.call("leaky");
    expect(res.json.error).toBe("internal_error");
    expect(res.text).not.toContain("10.0.0.5");
    expect(res.text).not.toContain("pw123456");
    // …but the audit log keeps a (redacted) cause for you
    expect(h.audit.at(-1)?.error).toContain("ECONNREFUSED");
    expect(h.audit.at(-1)?.error).not.toContain("pw123456");
  });

  it("truncates oversized output", async () => {
    const big: ToolDef<any> = { ...echo, name: "big", maxOutputChars: 100, input: {}, run: async () => ({ s: "x".repeat(1000) }) };
    h = await startHarness({ tools: [big] });
    expect((await h.call("big")).text).toMatch(/truncated \d+ chars/);
  });

  it("audits every call", async () => {
    h = await startHarness({ tools: [echo] });
    await h.call("echo", { msg: "a" });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ tool: "echo", ok: true, args: { msg: "a" } });
  });
});
