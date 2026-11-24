import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Call, createApprovals, hashArgs, MAX_FORM_CHARS, type StateSealer } from "../../src/approval.js";

const SECRET = "hunter2-db-password";
const CALL: Call = {
  tool: "k8s_rollout_restart",
  args: { namespace: "app", deployment: "api", reason: `logs show the password ${SECRET}` },
};
const Facts = z.object({ resourceVersion: z.string() });
const FACTS = { resourceVersion: "4711" };

/** Keeps what was minted, so a test can hand it back as the server's verify hook would. */
function recordingSealer() {
  const minted: unknown[] = [];
  const sealer: StateSealer = {
    mint: async (payload) => {
      minted.push(payload);
      return `sealed-${minted.length}`;
    },
  };
  return { sealer, minted };
}

const accepted = (approve: boolean) => ({ approval: { action: "accept", content: { approve } } });

async function askedOnce(facts: unknown = FACTS) {
  const { sealer, minted } = recordingSealer();
  const approvals = createApprovals(sealer);
  const form = await approvals.ask(CALL, "Restart app/api?", facts);
  return { approvals, form, state: minted[0] };
}

describe("approvals", () => {
  it("asks with a form and sealed state, and nothing is decided before an answer", async () => {
    const { approvals, form } = await askedOnce();
    expect(form).toMatchObject({
      requestState: "sealed-1",
      inputRequests: { approval: { method: "elicitation/create" } },
    });
    expect(approvals.decide(CALL, {}, Facts)).toEqual({ kind: "unanswered" });
  });

  it("seals a hash of the arguments, never their text: the client can read the state", async () => {
    const { state } = await askedOnce();
    expect(state).toEqual({ tool: CALL.tool, argsHash: hashArgs(CALL.args), nonce: expect.any(String), facts: FACTS });
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });

  it("approves an accepted approve, with the facts it was asked on", async () => {
    const { approvals, state } = await askedOnce();
    const round = { requestState: state, inputResponses: accepted(true) };
    expect(approvals.decide(CALL, round, Facts)).toEqual({ kind: "approved", facts: FACTS });
  });

  it("decides a form once: the same round sent again is refused", async () => {
    const { approvals, state } = await askedOnce();
    const round = { requestState: state, inputResponses: accepted(true) };
    approvals.decide(CALL, round, Facts);
    expect(approvals.decide(CALL, round, Facts)).toMatchObject({
      kind: "not_approved",
      why: expect.stringMatching(/already/),
    });
  });

  it("does not let a declined form be sent again as an approval", async () => {
    const { approvals, state } = await askedOnce();
    approvals.decide(CALL, { requestState: state, inputResponses: { approval: { action: "decline" } } }, Facts);
    const resent = { requestState: state, inputResponses: accepted(true) };
    expect(approvals.decide(CALL, resent, Facts)).toMatchObject({ kind: "not_approved" });
  });

  it.each([
    ["an unticked approve", accepted(false), /did not approve/],
    ["a decline", { approval: { action: "decline" } }, /did not approve/],
    ["a closed form", { approval: { action: "cancel" } }, /closed/],
    ["no answer", undefined, /did not approve/],
  ])("does not approve %s", async (_name, inputResponses, why) => {
    const { approvals, state } = await askedOnce();
    expect(approvals.decide(CALL, { requestState: state, inputResponses }, Facts)).toMatchObject({
      kind: "not_approved",
      why: expect.stringMatching(why),
    });
  });

  it("does not approve state for another action, or state the server did not verify", async () => {
    const { approvals, state } = await askedOnce();
    const otherDeployment = { ...CALL, args: { ...CALL.args, deployment: "worker" } };
    const answered = { inputResponses: accepted(true) };
    expect(approvals.decide(otherDeployment, { ...answered, requestState: state }, Facts)).toMatchObject({
      why: expect.stringMatching(/different action/),
    });
    // Without the verify hook the tool sees the raw string the client sent.
    expect(approvals.decide(CALL, { ...answered, requestState: "sealed-1" }, Facts)).toMatchObject({
      kind: "not_approved",
    });
    expect(approvals.decide(CALL, answered, Facts)).toMatchObject({ kind: "not_approved" });
  });

  it("does not approve facts that do not match what the tool expects", async () => {
    const { approvals, state } = await askedOnce({ resourceVersion: 4711 });
    const round = { requestState: state, inputResponses: accepted(true) };
    expect(approvals.decide(CALL, round, Facts)).toMatchObject({
      kind: "not_approved",
      why: expect.stringMatching(/facts/),
    });
  });

  it("cuts a message too long for a human to read, and says so", async () => {
    const approvals = createApprovals(recordingSealer().sealer);
    const form = await approvals.ask(CALL, "x".repeat(MAX_FORM_CHARS + 500), FACTS);
    const message = JSON.stringify(form.inputRequests);
    expect(message).toContain(`[cut: the message was ${MAX_FORM_CHARS + 500} characters]`);
    expect(message.length).toBeLessThan(MAX_FORM_CHARS + 500);
  });
});
