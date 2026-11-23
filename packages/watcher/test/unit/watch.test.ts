import { describe, expect, it } from "vitest";
import type { AgentRun } from "../../src/agent.js";
import { findingsOf, initialState, type Policy, type Triage } from "../../src/incidents.js";
import type { Report } from "../../src/report.js";
import { check, type InvestigationPrompt, investigationPrompt, type WatchDeps } from "../../src/watch.js";

const POLICY: Policy = { ignore: [], resolveAfterChecks: 1, maxPerHour: 5, maxPerDay: 20 };
const NOW = new Date("2026-11-23T12:00:00Z");

const LOCK_WAIT: Triage = {
  problems: { pg_blocking: ["1 session waiting on locks; root blockers: pid 4242"] },
  clean: ["redis_slowlog"],
  unavailable: {},
  not_installed: { pg_job_queues: "pg-boss is not installed" },
};

const RUN: AgentRun = {
  outcome: "answered",
  report: "Root cause: an idle transaction holds the orders row lock.",
  turns: 2,
  toolCalls: [],
  costUsd: 0.0012,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  transcript: [],
};

/** Fake deps that answer triage from a script and record investigations and reports. */
function fakeDeps(triages: ReadonlyArray<Triage | Error>, investigate: () => Promise<AgentRun> = async () => RUN) {
  const reports: Report[] = [];
  const prompts: InvestigationPrompt[] = [];
  let calls = 0;
  const deps: WatchDeps = {
    triage: async () => {
      const next = triages[calls++];
      if (next === undefined) throw new Error("the script ran out of checks");
      if (next instanceof Error) throw next;
      return next;
    },
    investigate: (prompt) => {
      prompts.push(prompt);
      return investigate();
    },
    report: async (report) => {
      reports.push(report);
    },
    now: () => NOW,
  };
  return { deps, reports, prompts };
}

describe("check", () => {
  it("investigates a new incident and reports what the agent found", async () => {
    const { deps, reports, prompts } = fakeDeps([LOCK_WAIT]);
    await check(initialState, deps, POLICY, ["app"]);
    expect(prompts).toHaveLength(1);
    expect(reports).toEqual([
      {
        at: "2026-11-23T12:00:00.000Z",
        event: "incident",
        incident: 1,
        findings: ["pg_blocking: 1 session waiting on locks; root blockers: pid 4242"],
        outcome: "answered",
        report: RUN.report,
        cost_usd: 0.0012,
        turns: 2,
      },
    ]);
  });

  it("stays quiet while the same incident is open, and reports it resolved when it is gone", async () => {
    const { deps, reports, prompts } = fakeDeps([
      LOCK_WAIT,
      LOCK_WAIT,
      { problems: {}, clean: [], unavailable: {}, not_installed: {} },
    ]);
    let state = initialState;
    for (let i = 0; i < 3; i++) state = await check(state, deps, POLICY, []);
    expect(prompts).toHaveLength(1);
    expect(reports.map((report) => report.event)).toEqual(["incident", "incident_resolved"]);
  });

  it("reports a failed triage and keeps the incidents it knew about", async () => {
    const { deps, reports, prompts } = fakeDeps([LOCK_WAIT, new Error("MCP connection closed"), LOCK_WAIT]);
    let state = initialState;
    for (let i = 0; i < 3; i++) state = await check(state, deps, POLICY, []);
    expect(reports.map((report) => report.event)).toEqual(["incident", "check_failed"]);
    expect(reports[1]).toMatchObject({ error: "MCP connection closed" });
    expect(prompts).toHaveLength(1);
  });

  it("reports a failed investigation instead of stopping the watcher", async () => {
    const failing = async () => {
      throw new Error("overloaded_error");
    };
    const { deps, reports } = fakeDeps([LOCK_WAIT], failing);
    await check(initialState, deps, POLICY, []);
    expect(reports).toEqual([expect.objectContaining({ event: "investigation_failed", error: "overloaded_error" })]);
  });

  it("records an incident without an investigation once the budget is spent", async () => {
    const { deps, reports, prompts } = fakeDeps([LOCK_WAIT]);
    await check(initialState, deps, { ...POLICY, maxPerHour: 0 }, []);
    expect(prompts).toEqual([]);
    expect(reports).toEqual([expect.objectContaining({ event: "incident_not_investigated", incident: 1 })]);
  });
});

describe("investigationPrompt", () => {
  it("gives the new problems as the incident and the whole triage as context", () => {
    const { symptom, context } = investigationPrompt(findingsOf(LOCK_WAIT), LOCK_WAIT, ["app", "jobs"]);
    expect(symptom).toBe(
      "The watcher found new problems:\n- pg_blocking: 1 session waiting on locks; root blockers: pid 4242",
    );
    expect(context).toContain("Kubernetes namespaces you may inspect: app, jobs.");
    expect(context).toContain('"not_installed":{"pg_job_queues":"pg-boss is not installed"}');
    expect(context).toContain("you do not need to run it again");
  });

  it("leaves out the namespaces line when Kubernetes is not configured", () => {
    const { context } = investigationPrompt(findingsOf(LOCK_WAIT), LOCK_WAIT, []);
    expect(context).not.toContain("namespaces");
  });
});
