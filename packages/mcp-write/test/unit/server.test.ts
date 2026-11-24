import { Client, type ClientOptions, isInputRequiredResult, withInputRequired } from "@modelcontextprotocol/client";
import { createRequestStateCodec, type ElicitResult, InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRedactor, defineTool, Level } from "@ops-agent/mcp-server/shared";
import { WRITE_SERVER_NAME } from "@ops-agent/watcher/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { K8sWriteClient } from "../../src/adapters/k8s-write.js";
import { createApprovals } from "../../src/approval.js";
import { createWriteServer, SERVER_NAME } from "../../src/server.js";
import type { WriteContext } from "../../src/types.js";

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

type Era = "legacy" | "modern";
const NEGOTIATION: Record<Era, ClientOptions["versionNegotiation"]> = {
  legacy: { mode: "legacy" },
  modern: { mode: { pin: "2026-07-28" } },
};

const unusedK8s: K8sWriteClient = {
  namespaces: [],
  getJson: async () => {
    throw new Error("no kubernetes in this test");
  },
  restartDeployment: async () => {
    throw new Error("no kubernetes in this test");
  },
};

let closeAll: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await closeAll?.();
  closeAll = undefined;
});

interface StartOptions {
  /** The test sends round 2 itself, with whatever requestState it likes (2026-07-28 era only). */
  readonly manualRounds?: boolean;
}

/** The write server as src/index.ts builds it, with a client whose human answers with `answer`. */
async function start(era: Era, answer?: () => Promise<ElicitResult>, options: StartOptions = {}) {
  const actions: string[] = [];
  const forms: string[] = [];
  const codec = createRequestStateCodec({ key: "k".repeat(32), ttlSeconds: 60 });
  const approvals = createApprovals(codec);
  const factory = () =>
    createWriteServer({
      tools: [probe(actions)],
      verifyState: codec.verify,
      registry: {
        maxLevel: Level.Change,
        redact: createRedactor([SECRET]),
        context: (signal, round) => ({ k8s: unusedK8s, approvals, round, signal, log: () => {} }),
      },
    }).server;

  const capabilities = answer ? { elicitation: { form: {} } } : {};
  const inputRequired = { autoFulfill: options.manualRounds !== true };
  const clientOptions = { capabilities, versionNegotiation: NEGOTIATION[era], inputRequired };
  const client = new Client({ name: "test-client", version: "0" }, clientOptions);
  if (answer) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params.message);
      return answer();
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(factory, { transport: serverSide });
  await client.connect(clientSide);
  closeAll = async () => {
    await client.close();
    await served.close();
  };

  const call = async (target: string, reason = "stuck") => {
    const result = await client.callTool({ name: "probe_action", arguments: { target, reason } });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    return JSON.parse(text);
  };
  return { client, call, actions, forms };
}

const approve = async (): Promise<ElicitResult> => ({ action: "accept", content: { approve: true } });
const decline = async (): Promise<ElicitResult> => ({ action: "decline" });

describe("the write server", () => {
  it("names itself as the watcher expects, so the watcher refuses it", () => {
    expect(SERVER_NAME).toBe(WRITE_SERVER_NAME);
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
