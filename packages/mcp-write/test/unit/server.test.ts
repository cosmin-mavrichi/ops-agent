import { isInputRequiredResult, withInputRequired } from "@modelcontextprotocol/client";
import { defineTool, Level } from "@ops-agent/mcp-server/shared";
import { WRITE_SERVER_NAME } from "@ops-agent/watcher/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createWriteServer, SERVER_NAME } from "../../src/server.js";
import { writeTools } from "../../src/tools/index.js";
import type { WriteContext } from "../../src/types.js";
import { approve, decline, type Era, type HarnessOptions, useHarness } from "../harness.js";

const SECRET = "hunter2-db-password";
const Facts = z.object({ version: z.string() });

/** Shaped like a write tool: ask in round 1, act in round 2 only on an approval. */
function probe(actions: string[]) {
  return defineTool({
    name: "probe_action",
    level: Level.Change,
    title: "Probe action",
    description: "test tool",
    input: { target: z.string(), reason: z.string() },
    async run(args, ctx: WriteContext) {
      const call = { tool: "probe_action", args };
      const decision = ctx.approvals.decide(call, ctx.round, Facts);
      if (decision.kind === "unanswered") {
        return ctx.approvals.ask(call, `Act on ${args.target}? Reason: ${args.reason}`, { version: "4711" });
      }
      if (decision.kind === "not_approved") return { status: "not approved", why: decision.why };
      actions.push(`${args.target}@${decision.facts.version}`);
      return { status: "done" };
    },
  });
}

const harness = useHarness();

const unreachableContext = (): WriteContext => {
  throw new Error("no tool runs in this test");
};

afterEach(() => {
  vi.useRealTimers();
});

async function start(era: Era, answer?: HarnessOptions["answer"], options: { manualRounds?: boolean } = {}) {
  const actions: string[] = [];
  const h = await harness({ tools: [probe(actions)], era, answer, knownSecrets: [SECRET], ...options });
  const call = async (target: string, reason = "stuck") => (await h.call("probe_action", { target, reason })).json;
  return { ...h, call, actions };
}

describe("the write server", () => {
  it("names itself as the watcher expects, so the watcher refuses it", () => {
    expect(SERVER_NAME).toBe(WRITE_SERVER_NAME);
  });

  it("exposes exactly its write tools, and none below Level.Change: surface changes are deliberate", () => {
    const serverAt = (maxLevel: Level) =>
      createWriteServer({
        tools: writeTools,
        verifyState: async () => undefined,
        registry: { maxLevel, redact: (text) => text, context: unreachableContext },
      });
    expect(serverAt(Level.Change).exposed).toEqual(["k8s_rollout_restart"]);
    expect(serverAt(Level.Read).exposed).toEqual([]);
  });
});

describe.each<Era>(["legacy", "modern"])("approval through the write server, %s era", (era) => {
  it("acts on an approval, with the facts sealed in round 1", async () => {
    const h = await start(era, approve);
    expect(await h.call("api")).toEqual({ status: "done" });
    expect(h.actions).toEqual(["api@4711"]);
    expect(h.client.getServerVersion()?.name).toBe(SERVER_NAME);
  });

  it("does not act on a decline", async () => {
    const h = await start(era, decline);
    expect(await h.call("api")).toEqual({ status: "not approved", why: "the human did not approve it" });
    expect(h.actions).toEqual([]);
  });

  it("asks again for every call: one approval never covers the next", async () => {
    const h = await start(era, approve);
    await h.call("api");
    await h.call("api");
    expect(h.forms).toHaveLength(2);
    expect(h.actions).toEqual(["api@4711", "api@4711"]);
  });

  it("redacts the form, which carries the agent's reason", async () => {
    const h = await start(era, decline);
    await h.call("api", `the password ${SECRET} leaked`);
    expect(h.forms[0]).not.toContain(SECRET);
  });

  it("never acts for a client that cannot show forms: the SDK refuses the form", async () => {
    const h = await start(era);
    const outcome = await h.client
      .callTool({ name: "probe_action", arguments: { target: "api", reason: "stuck" } })
      .then((result) => JSON.stringify(result))
      .catch((error: Error) => error.message);
    expect(outcome).toMatch(/capabilit/i);
    expect(h.actions).toEqual([]);
  });
});

describe("a requestState the server did not issue, 2026-07-28 era", () => {
  const ARGS = { target: "api", reason: "stuck" };
  const APPROVED = { approval: { action: "accept", content: { approve: true } } };

  async function firstRound(h: Awaited<ReturnType<typeof start>>): Promise<string> {
    const request = { method: "tools/call", params: { name: "probe_action", arguments: ARGS } };
    const resultSchema = withInputRequired(z.object({}).loose());
    const first = await h.client.request(request, resultSchema, { allowInputRequired: true });
    if (!isInputRequiredResult(first) || first.requestState === undefined) throw new Error("expected a form");
    return first.requestState;
  }

  const secondRound = (h: Awaited<ReturnType<typeof start>>, requestState: string) => {
    const params = { name: "probe_action", arguments: ARGS, inputResponses: APPROVED, requestState };
    return h.client.request({ method: "tools/call", params });
  };

  it("acts on the state it issued, sent back untouched", async () => {
    const h = await start("modern", approve, { manualRounds: true });
    await secondRound(h, await firstRound(h));
    expect(h.actions).toEqual(["api@4711"]);
  });

  it("refuses a tampered state with an error, before the tool runs", async () => {
    const h = await start("modern", approve, { manualRounds: true });
    const issued = await firstRound(h);
    const tampered = `${issued.slice(0, -2)}${issued.endsWith("AA") ? "BB" : "AA"}`;
    await expect(secondRound(h, tampered)).rejects.toThrow(/Invalid or expired requestState/);
    expect(h.actions).toEqual([]);
  });

  it("refuses an expired state, once the form has been open past its time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await start("modern", approve, { manualRounds: true });
    const issued = await firstRound(h);
    vi.setSystemTime(Date.now() + 61_000);
    await expect(secondRound(h, issued)).rejects.toThrow(/Invalid or expired requestState/);
    expect(h.actions).toEqual([]);
  });
});
