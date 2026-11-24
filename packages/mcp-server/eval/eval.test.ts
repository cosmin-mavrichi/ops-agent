/**
 * Agent evals: each lab scenario breaks one thing, the agent gets only the symptom and diagnoses it with the
 * real tools, and its report is graded (eval/cases.md). Guardrails are checked in code and fail the test; the
 * diagnosis is a score.
 *
 * Each run calls a model, so it costs money or subscription usage: name the scenarios, SCENARIO=crash-loop
 * pnpm eval (EVAL_ALL=1 for every scenario). Never runs in CI. Backend and keys: see .env.example.
 * Results: eval/results/<run>/report.md to read; results.jsonl (one row per scenario) and traces/<scenario>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentRun } from "@ops-agent/watcher/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Lab, startLab } from "../lab/scenario.js";
import { selectScenarios } from "../lab/scenarios/index.js";
import { assertBackendRuns, diagnose, grade } from "./backends.js";
import { checkRun, passesChecks } from "./checks.js";
import { loadDotEnv, loadEvalConfig } from "./config.js";
import { countWords, type Row, reportMarkdown, summaryTable } from "./summary.js";

loadDotEnv(new URL("../../../.env", import.meta.url));
const config = loadEvalConfig(process.env);
const selected = selectScenarios(config.scenarios);
assertBackendRuns(config, selected);
const runName = new Date().toISOString().replaceAll(":", "-");
const runDir = new URL(`./results/${runName}/`, import.meta.url);
const runTitle = `Eval ${runName}: ${config.backend}, agent ${config.model}, judge ${config.judgeModel}`;
mkdirSync(new URL("traces/", runDir), { recursive: true });
console.log(`${runTitle}; ${selected.length} scenario(s)`);

const rows: Row[] = [];

function record(row: Row, run: AgentRun): void {
  rows.push(row);
  writeFileSync(new URL("results.jsonl", runDir), `${rows.map((each) => JSON.stringify(each)).join("\n")}\n`);
  writeFileSync(new URL(`traces/${row.scenario}.json`, runDir), `${JSON.stringify(run.transcript, null, 2)}\n`);
  writeFileSync(new URL("report.md", runDir), reportMarkdown(rows, runTitle));
}

describe.each(selected)("$name", (scenario) => {
  let lab: Lab;

  beforeAll(async () => {
    lab = await startLab(scenario);
    await scenario.break(lab);
  }, 360_000);

  afterAll(async () => {
    await lab?.stop();
  }, 120_000);

  it("diagnoses the incident within the guardrails", async () => {
    const mcpTools = await lab.listTools();
    const run = await diagnose(config, lab, scenario, mcpTools);
    const allowed = {
      tools: new Set(mcpTools.map((tool) => tool.name)),
      writeTools: new Set(lab.write?.tools.map((tool) => tool.name)),
      expectedActions: new Set(scenario.write?.expectedActions),
    };
    const checks = checkRun(run, allowed, scenario.secrets);
    const judgement = await grade(config, scenario, run.report);
    record(
      {
        scenario: scenario.name,
        model: config.model,
        judge_model: config.judgeModel,
        outcome: run.outcome,
        turns: run.turns,
        tools: run.toolCalls.map((call) => call.name),
        checks,
        verdict: judgement.verdict,
        cost_usd: run.costUsd + judgement.costUsd,
        usage: run.usage,
        report: run.report,
        report_words: countWords(run.report),
      },
      run,
    );

    expect(checks.leakedSecrets, "planted secrets in the transcript").toEqual([]);
    expect(checks.disallowedTools, "tools outside the server's surface").toEqual([]);
    expect(checks.unexpectedActions, "actions the scenario's fix does not call for").toEqual([]);
    expect(passesChecks(checks), `stopped by a limit: ${run.outcome}`).toBe(true);
  }, 600_000);
});

afterAll(() => {
  if (rows.length > 0) console.log(`\n${summaryTable(rows)}\nread: ${fileURLToPath(new URL("report.md", runDir))}`);
});
