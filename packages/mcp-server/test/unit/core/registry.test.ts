import { ProtocolError } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { allTools } from "../../../src/tools/index.js";
import { defineTool, Level, type ToolDef, ToolError } from "../../../src/types.js";
import { useHarness } from "../../harness.js";

const echo = defineTool({
  name: "echo",
  level: Level.Read,
  title: "echo",
  description: "test",
  input: { msg: z.string().max(50) },
  run: async ({ msg }) => ({ msg }),
});
const restart = defineTool({
  name: "restart_service",
  level: Level.Change,
  title: "restart",
  description: "test",
  input: {},
  run: async () => ({ restarted: true }),
});
const nuke = defineTool({
  name: "restore_backup",
  level: Level.Dangerous,
  title: "restore",
  description: "test",
  input: {},
  run: async () => ({ restored: true }),
});

const harness = useHarness();

describe("level gating", () => {
  it("v1 exposes only level-1 tools", async () => {
    const h = await harness({ tools: [echo, restart, nuke], maxLevel: Level.Read });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("a hidden tool cannot be called even by name", async () => {
    const h = await harness({ tools: [echo, restart] });
    // MCP SDK v2 rejects unknown tools at the protocol level instead of returning an isError result.
    const err = await h.call("restart_service").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).message).toContain("not found");
    expect(h.audit).toHaveLength(0); // the handler never ran
  });

  it("marks read tools as readOnly in annotations", async () => {
    const h = await harness({ tools: [echo] });
    const { tools } = await h.client.listTools();
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  /** Snapshot of the real v1 surface: adding a tool forces a deliberate snapshot update in review. */
  it("real v1 tool list", async () => {
    const h = await harness({ tools: allTools });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toMatchInlineSnapshot(`
      [
        "k8s_certificates",
        "k8s_events",
        "k8s_logs",
        "k8s_pg_backups",
        "k8s_pods",
        "pg_activity",
        "pg_blocking",
        "pg_slow_queries",
        "prom_volume_usage",
        "redis_health",
        "redis_slowlog",
      ]
    `);
    expect(allTools.every((t) => t.level === Level.Read)).toBe(true);
  });
});

describe("call pipeline", () => {
  it("rejects invalid and unknown arguments", async () => {
    const h = await harness({ tools: [echo] });
    expect((await h.call("echo", { msg: "x".repeat(51) })).isError).toBe(true);
    expect((await h.call("echo", { msg: "hi", extra: "; rm -rf /" })).isError).toBe(true);
  });

  it("redacts secrets in results", async () => {
    const h = await harness({ tools: [echo], knownSecrets: ["topsecretvalue"] });
    const res = await h.call("echo", { msg: "pw is topsecretvalue" });
    expect(res.text).not.toContain("topsecretvalue");
  });

  it("keeps the output valid JSON when a value is redacted", async () => {
    const h = await harness({ tools: [echo] });
    const res = await h.call("echo", { msg: "API_KEY=sk_live_123456" });
    expect(res.json).toEqual({ msg: "API_KEY=***" });
  });

  it("finds known secrets that JSON would escape", async () => {
    const secret = 'pa"ss\\word99';
    const h = await harness({ tools: [echo], knownSecrets: [secret] });
    const res = await h.call("echo", { msg: `login with ${secret}` });
    expect(res.json).toEqual({ msg: "login with ***" });
  });

  it("times out slow tools", async () => {
    const slow: ToolDef<any> = {
      ...echo,
      name: "slow",
      timeoutMs: 50,
      input: {},
      run: () => new Promise((r) => setTimeout(r, 500)),
    };
    const h = await harness({ tools: [slow] });
    const res = await h.call("slow");
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe("timeout");
  });

  it("aborts the tool when the client cancels the request", async () => {
    let toolSignal: AbortSignal | undefined;
    const hang: ToolDef<any> = {
      ...echo,
      name: "hang",
      input: {},
      run: (_args, { signal }) => {
        toolSignal = signal;
        return new Promise(() => {});
      },
    };
    const h = await harness({ tools: [hang] });
    const client = new AbortController();

    const call = h.client.callTool({ name: "hang", arguments: {} }, { signal: client.signal });
    await vi.waitFor(() => expect(toolSignal).toBeDefined());
    client.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(h?.audit.at(-1)?.error).toBe("cancelled"));
    expect(toolSignal?.aborted).toBe(true);
  });

  it("passes ToolError messages through, hides unexpected errors", async () => {
    const expected: ToolDef<any> = {
      ...echo,
      name: "expected",
      input: {},
      run: async () => {
        throw new ToolError("unavailable", "extension missing");
      },
    };
    const leaky: ToolDef<any> = {
      ...echo,
      name: "leaky",
      input: {},
      run: async () => {
        throw new Error("connect ECONNREFUSED postgres://app:pw123456@10.0.0.5");
      },
    };
    const h = await harness({ tools: [expected, leaky] });

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
    const big: ToolDef<any> = {
      ...echo,
      name: "big",
      maxOutputChars: 100,
      input: {},
      run: async () => ({ s: "x".repeat(1000) }),
    };
    const h = await harness({ tools: [big] });
    expect((await h.call("big")).text).toMatch(/truncated \d+ chars/);
  });

  it("audits every call", async () => {
    const h = await harness({ tools: [echo] });
    await h.call("echo", { msg: "a" });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ tool: "echo", ok: true, args: { msg: "a" } });
  });
});
