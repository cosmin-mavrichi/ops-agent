import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import {
  type ElicitResult,
  InMemoryTransport,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRedactor, KNOWN_SECRET_MARKER } from "../../../src/lib/redact.js";
import { type AuditEntry, registerTools } from "../../../src/registry.js";
import { defineTool, Level, type Round } from "../../../src/types.js";

const SECRET = "hunter2-db-password";
// Looks like a token to the redactor's patterns; it must still reach the second round untouched.
const STATE = "v1.eyJwIjp7Im5hbWUiOiJhcGkifSwiZXhwIjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const Approval = z.object({ approve: z.boolean() });

interface ProbeContext {
  readonly round: Round;
}

/** Asks once for approval, then reports what the second round received. */
function confirmProbe(actions: string[]) {
  return defineTool({
    name: "confirm_probe",
    level: Level.Change,
    title: "Confirm probe",
    description: "test tool",
    input: { note: z.string() },
    timeoutMs: 200,
    async run({ note }, ctx: ProbeContext) {
      const answer = inputResponse(ctx.round.inputResponses, "approval");
      if (answer.kind === "missing") {
        const form = inputRequired.elicit({ message: `Approve? ${note}`, requestedSchema: Approval });
        return inputRequired({ inputRequests: { approval: form }, requestState: STATE });
      }
      const approved = answer.kind === "elicit" && answer.action === "accept" && answer.content?.approve === true;
      if (approved) actions.push(note);
      return { approved, stateIntact: ctx.round.requestState === STATE };
    },
  });
}

type Era = "legacy" | "modern";
const NEGOTIATION: Record<Era, ClientOptions["versionNegotiation"]> = {
  legacy: { mode: "legacy" },
  modern: { mode: { pin: "2026-07-28" } },
};

interface Setup {
  readonly era: Era;
  /** How the human at the client answers; undefined = a client that cannot show forms. */
  readonly answer?: (message: string) => Promise<ElicitResult>;
}

let closeAll: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeAll?.();
  closeAll = undefined;
});

async function start({ era, answer }: Setup) {
  const actions: string[] = [];
  const audit: AuditEntry[] = [];
  const forms: string[] = [];
  const factory = () => {
    const server = new McpServer({ name: "ops-test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerTools(server, [confirmProbe(actions)], {
      maxLevel: Level.Change,
      redact: createRedactor([SECRET]),
      context: (_signal, round): ProbeContext => ({ round }),
      audit: (entry) => audit.push(entry),
    });
    return server;
  };

  const capabilities = answer ? { elicitation: { form: {} } } : {};
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities, versionNegotiation: NEGOTIATION[era] },
  );
  if (answer) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params.message);
      return answer(request.params.message);
    });
  }
  // Served the way src/index.ts serves stdio, so the client's protocol era picks the path, as in production.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(factory, { transport: serverSide });
  await client.connect(clientSide);
  closeAll = async () => {
    await client.close();
    await served.close();
  };

  const call = async (note: string) => {
    const result = await client.callTool({ name: "confirm_probe", arguments: { note } });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isError: result.isError === true, json: JSON.parse(text) };
  };
  /** The raw outcome, refusals included: a result's text, or the error the call was rejected with. */
  const outcome = (note: string) =>
    client
      .callTool({ name: "confirm_probe", arguments: { note } })
      .then((result) => JSON.stringify(result))
      .catch((error: Error) => error.message);
  return { call, outcome, actions, audit, forms };
}

const approve = async (): Promise<ElicitResult> => ({ action: "accept", content: { approve: true } });
const decline = async (): Promise<ElicitResult> => ({ action: "decline" });

describe.each<Era>(["legacy", "modern"])("tools that ask for input, %s era", (era) => {
  it("acts in the second round, on an approval, with the state from the first", async () => {
    const h = await start({ era, answer: approve });
    expect(await h.call("restart api")).toEqual({ isError: false, json: { approved: true, stateIntact: true } });
    expect(h.actions).toEqual(["restart api"]);
    expect(h.audit.map((entry) => entry.awaitingInput ?? false)).toEqual([true, false]);
  });

  it("does not act on a decline", async () => {
    const h = await start({ era, answer: decline });
    expect((await h.call("restart api")).json).toEqual({ approved: false, stateIntact: true });
    expect(h.actions).toEqual([]);
  });

  it("redacts the form like output", async () => {
    const h = await start({ era, answer: approve });
    await h.call(`password is ${SECRET}`);
    expect(h.forms).toEqual([`Approve? password is ${KNOWN_SECRET_MARKER}`]);
  });

  it("does not count the human's time against the tool's timeout", async () => {
    const slowApproval = async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return approve();
    };
    const h = await start({ era, answer: slowApproval });
    expect(await h.call("restart api")).toEqual({ isError: false, json: { approved: true, stateIntact: true } });
  });

  it("never reaches the second round with a client that cannot show forms: the SDK refuses the form", async () => {
    const h = await start({ era });
    expect(await h.outcome("restart api")).toMatch(/capabilit/i);
    expect(h.actions).toEqual([]);
    expect(h.audit.map((entry) => entry.awaitingInput ?? false)).toEqual([true]);
  });
});
