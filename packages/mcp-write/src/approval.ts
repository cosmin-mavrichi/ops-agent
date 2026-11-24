import { createHash, randomUUID } from "node:crypto";
import { acceptedContent, type InputRequiredResult, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import type { Round } from "@ops-agent/mcp-server/shared";
import { z } from "zod";

/** How long a form stays answerable; past it the requestState no longer verifies and the agent proposes again. */
export const APPROVAL_TTL_S = 15 * 60;
const FORM_KEY = "approval";
/** A form is read by a human: past this, the tool's message is cut rather than shown whole. */
export const MAX_FORM_CHARS = 4_000;

const Answer = z.object({ approve: z.boolean().describe("Approve this action") });

/** The tool call an approval is for. A sealed approval acts only on the same tool with the same arguments. */
export interface Call {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

// Signed, not encrypted: the client can read it. So it holds a hash of the arguments, never their text (the
// model's reason can repeat a secret from logs), and only facts that are not secret.
const Sealed = z.object({
  tool: z.string(),
  argsHash: z.string(),
  /** One form is decided once: the client holds round 2 and could send it again. */
  nonce: z.string(),
  facts: z.unknown(),
});
type Sealed = z.infer<typeof Sealed>;

/** Seals the state carried between rounds (the SDK's HMAC codec in production). */
export interface StateSealer {
  mint(payload: Sealed): Promise<string>;
}

export type Decision<F> =
  | { readonly kind: "unanswered" }
  | { readonly kind: "approved"; readonly facts: F }
  | { readonly kind: "not_approved"; readonly why: string };

export interface Approvals {
  /** Round 1: the form, and the facts the action must rest on (names, resourceVersion; signed, not secret). */
  ask(call: Call, message: string, facts: unknown): Promise<InputRequiredResult>;
  /**
   * Round 2: approved only with a verified requestState for this same call, not decided before, and an accepted
   * "approve". The facts are parsed with `factsSchema`, the schema of what `ask` sealed.
   */
  decide<F>(call: Call, round: Round, factsSchema: z.ZodType<F>): Decision<F>;
}

export function createApprovals(sealer: StateSealer): Approvals {
  const decided = new Set<string>();

  async function ask(call: Call, message: string, facts: unknown): Promise<InputRequiredResult> {
    const sealed: Sealed = { tool: call.tool, argsHash: hashArgs(call.args), nonce: randomUUID(), facts };
    const form = inputRequired.elicit({ message: capped(message), requestedSchema: Answer });
    return inputRequired({ inputRequests: { [FORM_KEY]: form }, requestState: await sealer.mint(sealed) });
  }

  function decide<F>(call: Call, round: Round, factsSchema: z.ZodType<F>): Decision<F> {
    if (round.requestState === undefined && round.inputResponses === undefined) return { kind: "unanswered" };
    // Verified by the server's requestState hook before the tool runs; without that hook this is the raw string
    // from the client, which does not parse, so nothing is approved.
    const sealed = Sealed.safeParse(round.requestState);
    if (!sealed.success) return notApproved("the approval's state is missing or was not issued by this server");
    if (sealed.data.tool !== call.tool || sealed.data.argsHash !== hashArgs(call.args)) {
      return notApproved("the approval was for a different action");
    }
    if (decided.has(sealed.data.nonce)) return notApproved("this form was already answered");
    // Any answer decides the form, so a decline cannot be sent again as an approval.
    decided.add(sealed.data.nonce);
    const answer = acceptedContent(round.inputResponses, FORM_KEY, Answer);
    if (answer?.approve !== true) return notApproved(declinedHow(round));
    const facts = factsSchema.safeParse(sealed.data.facts);
    if (!facts.success) return notApproved("the approval's facts do not match this action");
    return { kind: "approved", facts: facts.data };
  }

  return { ask, decide };
}

/** Same call, same hash: the registry hands tools their arguments as zod rebuilt them, in the shape's key order. */
export function hashArgs(args: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("base64url");
}

function capped(message: string): string {
  if (message.length <= MAX_FORM_CHARS) return message;
  return `${message.slice(0, MAX_FORM_CHARS)}\n[cut: the message was ${message.length} characters]`;
}

const notApproved = (why: string) => ({ kind: "not_approved", why }) as const;

function declinedHow(round: Round): string {
  const response = inputResponse(round.inputResponses, FORM_KEY);
  if (response.kind === "elicit" && response.action === "cancel") return "the form was closed without an answer";
  return "the human did not approve it";
}
