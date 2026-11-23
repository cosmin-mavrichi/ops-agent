/** What ops_triage returns. */
export interface Triage {
  readonly problems: Readonly<Record<string, readonly string[]>>;
  readonly clean: readonly string[];
  readonly unavailable: Readonly<Record<string, string>>;
  readonly not_installed: Readonly<Record<string, string>>;
}

export interface Finding {
  readonly tool: string;
  readonly text: string;
  /** The same problem a minute later, with new counts, ages and pod names, has the same fingerprint. */
  readonly fingerprint: string;
}

// Kubernetes builds random name suffixes from consonants and digits only, so words like "cache" never match.
const RANDOM = "[bcdfghjklmnpqrstvwxz2456789]";
const POD_SUFFIX = new RegExp(`-(?:${RANDOM}{8,10}-)?${RANDOM}{5}\\b`, "g");
const TIMESTAMP = /\d{4}-\d\d-\d\dT[\d:.]+Z?/g;
// A span crossing a unit ("1 hour" → "59 minutes") is the same problem.
const SPAN = /\d+(?:\.\d+)? (?:second|minute|hour|day)s?\b/g;
const NUMBER = /\d+(?:\.\d+)?/g;

export function fingerprint(tool: string, text: string): string {
  const stable = text
    .replace(TIMESTAMP, "<time>")
    .replace(POD_SUFFIX, "-*")
    .replace(SPAN, "<span>")
    .replace(NUMBER, "#");
  return `${tool}: ${stable}`;
}

/** Lines that only say more are listed (ops_triage's cap) carry no problem of their own. */
const isCapNote = (text: string) => text.startsWith("…and ");

const findingOf = (tool: string, text: string): Finding => ({ tool, text, fingerprint: fingerprint(tool, text) });

/**
 * Problems, and checks that could not run: an unreachable database is the incident, not a reason to stay quiet.
 * Software the stack does not run (not_installed) is no finding.
 */
export function findingsOf(triage: Triage): Finding[] {
  const problems = Object.entries(triage.problems).flatMap(([tool, texts]) =>
    texts.filter((text) => !isCapNote(text)).map((text) => findingOf(tool, text)),
  );
  const unavailable = Object.entries(triage.unavailable).map(([tool, reason]) =>
    findingOf(tool, `could not run: ${reason}`),
  );
  return [...problems, ...unavailable];
}

export interface Policy {
  /** Case-insensitive substrings of "tool: problem" for known, accepted problems. */
  readonly ignore: readonly string[];
  /** Checks in a row a problem must be gone before its incident counts as resolved. */
  readonly resolveAfterChecks: number;
  readonly maxPerHour: number;
  readonly maxPerDay: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const isIgnored = (finding: Finding, policy: Policy) => {
  const line = `${finding.tool}: ${finding.text}`.toLowerCase();
  return policy.ignore.some((pattern) => line.includes(pattern.toLowerCase()));
};

interface Open {
  readonly incident: number;
  readonly finding: Finding;
  /** Checks in a row this problem has not been seen. */
  readonly missing: number;
}

export interface State {
  /** Open problems by fingerprint. */
  readonly open: ReadonlyMap<string, Open>;
  /** When investigations started (epoch ms), for the hourly and daily caps. */
  readonly investigations: readonly number[];
  readonly nextIncident: number;
}

export const initialState: State = { open: new Map(), investigations: [], nextIncident: 1 };

export type Action =
  | { readonly kind: "investigate"; readonly incident: number; readonly findings: readonly Finding[] }
  | {
      readonly kind: "over_budget";
      readonly incident: number;
      readonly findings: readonly Finding[];
      readonly reason: string;
    }
  | { readonly kind: "resolved"; readonly incident: number; readonly findings: readonly Finding[] };

function budgetReason(investigations: readonly number[], now: number, policy: Policy): string | undefined {
  const lastHour = investigations.filter((at) => at > now - HOUR_MS).length;
  const lastDay = investigations.filter((at) => at > now - DAY_MS).length;
  if (lastHour >= policy.maxPerHour) return `${lastHour} investigations in the last hour (limit ${policy.maxPerHour})`;
  if (lastDay >= policy.maxPerDay) return `${lastDay} investigations in the last day (limit ${policy.maxPerDay})`;
  return undefined;
}

/** Problems seen this check keep their incident; the others count one more check missing. */
function carryOver(open: ReadonlyMap<string, Open>, seen: ReadonlySet<string>): Map<string, Open> {
  const next = new Map<string, Open>();
  for (const [key, entry] of open) {
    const missing = seen.has(key) ? 0 : entry.missing + 1;
    next.set(key, { ...entry, missing });
  }
  return next;
}

const uniqueByFingerprint = (findings: readonly Finding[]) => [
  ...new Map(findings.map((finding) => [finding.fingerprint, finding])).values(),
];

/** The new problems of this check, as one incident: investigated, or only recorded when over budget. */
function openIncident(state: State, fresh: readonly Finding[], now: number, policy: Policy) {
  const incident = state.nextIncident;
  const entries = fresh.map((finding) => [finding.fingerprint, { incident, finding, missing: 0 }] as const);
  const reason = budgetReason(state.investigations, now, policy);
  if (reason) {
    const action: Action = { kind: "over_budget", incident, findings: fresh, reason };
    return { entries, action, investigations: state.investigations };
  }
  const action: Action = { kind: "investigate", incident, findings: fresh };
  return { entries, action, investigations: [...state.investigations, now] };
}

/** Incidents all of whose problems have been gone long enough. */
function resolvedIncidents(open: ReadonlyMap<string, Open>, policy: Policy): Action[] {
  const byIncident = new Map<number, Open[]>();
  for (const entry of open.values()) byIncident.set(entry.incident, [...(byIncident.get(entry.incident) ?? []), entry]);
  return [...byIncident]
    .filter(([, entries]) => entries.every((entry) => entry.missing >= policy.resolveAfterChecks))
    .map(([incident, entries]) => ({ kind: "resolved", incident, findings: entries.map((entry) => entry.finding) }));
}

/**
 * One check's worth of decisions. Every problem new in this check belongs to one new incident (a crash loop shows
 * up as a pod, an event and a log line at once), so it costs one investigation, not one per line.
 */
export function step(state: State, findings: readonly Finding[], now: Date, policy: Policy) {
  const relevant = findings.filter((finding) => !isIgnored(finding, policy));
  const seen = new Set(relevant.map((finding) => finding.fingerprint));
  const carried = carryOver(state.open, seen);

  const resolved = resolvedIncidents(carried, policy);
  const closed = new Set(resolved.map((action) => action.incident));
  const stillOpen = new Map([...carried].filter(([, entry]) => !closed.has(entry.incident)));

  const fresh = uniqueByFingerprint(relevant.filter((finding) => !stillOpen.has(finding.fingerprint)));
  if (fresh.length === 0) return { state: { ...state, open: stillOpen }, actions: resolved };

  const nowMs = now.getTime();
  const opened = openIncident(state, fresh, nowMs, policy);
  const next: State = {
    open: new Map([...stillOpen, ...opened.entries]),
    investigations: opened.investigations.filter((at) => at > nowMs - DAY_MS),
    nextIncident: state.nextIncident + 1,
  };
  return { state: next, actions: [...resolved, opened.action] };
}
