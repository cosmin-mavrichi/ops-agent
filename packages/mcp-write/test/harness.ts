import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import { createRequestStateCodec, type ElicitResult, InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type AuditEntry, createRedactor, Level, type ToolList } from "@ops-agent/mcp-server/shared";
import { afterEach } from "vitest";
import type { K8sWriteClient } from "../src/adapters/k8s-write.js";
import { createApprovals } from "../src/approval.js";
import { createExclusive } from "../src/exclusive.js";
import { createWriteServer } from "../src/server.js";
import type { RolloutTiming } from "../src/tools/k8s/rollout-check.js";
import type { WriteContext } from "../src/types.js";

export type Era = "legacy" | "modern";
const CALL_TIMEOUT_MS = 300_000;
const NEGOTIATION: Record<Era, ClientOptions["versionNegotiation"]> = {
  legacy: { mode: "legacy" },
  modern: { mode: { pin: "2026-07-28" } },
};

/** Fast enough for unit tests; the shape of production's two minutes plus one. */
export const TEST_ROLLOUT: RolloutTiming = { rolledOutWithinMs: 300, healthyForMs: 60, pollMs: 5 };

export interface HarnessOptions {
  readonly tools: ToolList<WriteContext>;
  readonly era?: Era;
  /** How the human at the client answers each form; undefined = a client that cannot show forms. */
  readonly answer?: () => Promise<ElicitResult>;
  /** The test sends round 2 itself, with whatever requestState it likes (2026-07-28 era only). */
  readonly manualRounds?: boolean;
  readonly k8s?: K8sWriteClient;
  readonly knownSecrets?: readonly string[];
  readonly rollout?: RolloutTiming;
  readonly now?: () => Date;
}

export interface LogLine {
  readonly msg: string;
  readonly meta?: Record<string, unknown>;
}

/** The write server as src/index.ts builds it, served over stdio's entry with an in-memory transport. */
export async function startHarness(opts: HarnessOptions) {
  const forms: string[] = [];
  const audit: AuditEntry[] = [];
  const logs: LogLine[] = [];
  const redact = createRedactor([...(opts.knownSecrets ?? [])]);
  const codec = createRequestStateCodec({ key: "k".repeat(32), ttlSeconds: 60 });
  const approvals = createApprovals(codec);
  const exclusive = createExclusive();
  const context = (signal: AbortSignal, round: WriteContext["round"]): WriteContext => ({
    k8s: opts.k8s ?? unusedK8s,
    approvals,
    exclusive,
    round,
    signal,
    now: opts.now ?? (() => new Date()),
    rollout: opts.rollout ?? TEST_ROLLOUT,
    redact,
    log: (msg, meta) => logs.push({ msg, meta }),
  });
  const factory = () =>
    createWriteServer({
      tools: opts.tools,
      verifyState: codec.verify,
      registry: {
        maxLevel: Level.Change,
        redact,
        context,
        audit: (entry) => audit.push(entry),
      },
    }).server;

  const capabilities = opts.answer ? { elicitation: { form: {} } } : {};
  const inputRequired = { autoFulfill: opts.manualRounds !== true };
  const clientOptions = { capabilities, versionNegotiation: NEGOTIATION[opts.era ?? "legacy"], inputRequired };
  const client = new Client({ name: "test-client", version: "0" }, clientOptions);
  const answer = opts.answer;
  if (answer) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params.message);
      return answer();
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(factory, { transport: serverSide });
  await client.connect(clientSide);

  /** Calls a tool; the result's text, parsed when it is JSON. */
  const call = async (name: string, args: Record<string, unknown>) => {
    // Above the restart's own 4-minute limit, so a slow rollout ends as the tool's result, not a client timeout.
    const result = await client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isError: result.isError === true, text, json: parseJson(text) };
  };
  const close = async () => {
    await client.close();
    await served.close();
  };
  return { client, call, forms, audit, logs, close };
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

/** Starts a harness inside a test and closes it after that test. */
export function useHarness() {
  let current: Harness | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  return async (opts: HarnessOptions) => {
    current = await startHarness(opts);
    return current;
  };
}

export const approve = async (): Promise<ElicitResult> => ({ action: "accept", content: { approve: true } });
export const decline = async (): Promise<ElicitResult> => ({ action: "decline" });

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const notInThisTest = async (): Promise<never> => {
  throw new Error("no kubernetes in this test");
};
const unusedK8s: K8sWriteClient = { namespaces: [], getJson: notInThisTest, restartDeployment: notInThisTest };
