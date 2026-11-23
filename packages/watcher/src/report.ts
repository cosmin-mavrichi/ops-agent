import { appendFile } from "node:fs/promises";
import type { Outcome } from "./agent.js";

interface Base {
  /** ISO time of the check that produced the event. */
  readonly at: string;
}

interface IncidentBase extends Base {
  readonly incident: number;
  /** "tool: problem" lines, as ops_triage reported them. */
  readonly findings: readonly string[];
}

/** One line of the report log: what the watcher decided and, for an investigation, what the agent found. */
export type Report =
  | (IncidentBase & {
      readonly event: "incident";
      readonly outcome: Outcome;
      readonly report: string;
      readonly cost_usd: number;
      readonly turns: number;
    })
  | (IncidentBase & { readonly event: "incident_not_investigated"; readonly reason: string })
  | (IncidentBase & { readonly event: "investigation_failed"; readonly error: string })
  | (IncidentBase & { readonly event: "incident_resolved" })
  | (Base & { readonly event: "check_failed"; readonly error: string });

export interface ReporterOptions {
  /** Appends each report as one JSON line, e.g. on a mounted volume. */
  readonly file?: string;
  readonly log: (line: string) => void;
}

export function createReporter({ file, log }: ReporterOptions) {
  return async (report: Report): Promise<void> => {
    const line = JSON.stringify(report);
    log(line);
    if (file) await appendFile(file, `${line}\n`);
  };
}
