import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRun } from "./agent.js";
import {
  type Action,
  type Finding,
  findingsOf,
  initialState,
  type Policy,
  type State,
  step,
  type Triage,
} from "./incidents.js";
import type { Report } from "./report.js";

export interface WatchDeps {
  readonly triage: () => Promise<Triage>;
  readonly investigate: (prompt: InvestigationPrompt) => Promise<AgentRun>;
  readonly report: (report: Report) => Promise<void>;
  readonly now: () => Date;
}

export interface InvestigationPrompt {
  readonly symptom: string;
  readonly context: string;
}

const lineOf = (finding: Finding) => `${finding.tool}: ${finding.text}`;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The agent starts with the evidence: the new problems are the incident report, and the whole triage (other open
 * problems, clean checks, checks that could not run) is context, so it does not spend a turn asking for it.
 */
export function investigationPrompt(findings: readonly Finding[], triage: Triage, namespaces: readonly string[]) {
  const symptom = `The watcher found new problems:\n${findings.map((finding) => `- ${lineOf(finding)}`).join("\n")}`;
  const scope = namespaces.length > 0 ? `Kubernetes namespaces you may inspect: ${namespaces.join(", ")}.\n` : "";
  const context =
    `${scope}ops_triage, run when these problems were found (problems by tool, clean checks, checks that could ` +
    `not run); you do not need to run it again:\n${JSON.stringify(triage)}`;
  return { symptom, context };
}

async function perform(action: Action, triage: Triage, deps: WatchDeps, at: string, namespaces: readonly string[]) {
  const base = { at, incident: action.incident, findings: action.findings.map(lineOf) };
  if (action.kind === "resolved") return deps.report({ ...base, event: "incident_resolved" });
  if (action.kind === "over_budget") {
    return deps.report({ ...base, event: "incident_not_investigated", reason: action.reason });
  }
  try {
    const run = await deps.investigate(investigationPrompt(action.findings, triage, namespaces));
    const result = { outcome: run.outcome, report: run.report, cost_usd: run.costUsd, turns: run.turns };
    return deps.report({ ...base, event: "incident", ...result });
  } catch (err) {
    return deps.report({ ...base, event: "investigation_failed", error: messageOf(err) });
  }
}

/** One check: run triage, decide, act. A failed triage changes nothing, so open incidents stay open. */
export async function check(state: State, deps: WatchDeps, policy: Policy, namespaces: readonly string[]) {
  const now = deps.now();
  const at = now.toISOString();
  let triage: Triage;
  try {
    triage = await deps.triage();
  } catch (err) {
    await deps.report({ at, event: "check_failed", error: messageOf(err) });
    return state;
  }
  const { state: next, actions } = step(state, findingsOf(triage), now, policy);
  for (const action of actions) await perform(action, triage, deps, at, namespaces);
  return next;
}

export interface WatchOptions {
  readonly policy: Policy;
  readonly intervalMs: number;
  readonly namespaces: readonly string[];
  readonly signal: AbortSignal;
}

/** Checks every interval until the signal aborts. */
export async function watch(deps: WatchDeps, { policy, intervalMs, namespaces, signal }: WatchOptions) {
  let state = initialState;
  while (!signal.aborted) {
    state = await check(state, deps, policy, namespaces);
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}
