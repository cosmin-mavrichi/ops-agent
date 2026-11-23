import { describe, expect, it } from "vitest";
import {
  type Finding,
  findingsOf,
  fingerprint,
  initialState,
  type Policy,
  type State,
  step,
  type Triage,
} from "../../src/incidents.js";

const POLICY: Policy = { ignore: [], resolveAfterChecks: 3, maxPerHour: 5, maxPerDay: 20 };
const T0 = new Date("2026-11-23T12:00:00Z");
const minutesLater = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const triage = (problems: Triage["problems"]): Triage => ({ problems, clean: [], unavailable: {}, not_installed: {} });

const CRASH_LOOP = triage({
  k8s_pods: [
    "1 of 2 pods unhealthy",
    "app/worker-f5f4bfbf4-99qzx (Deployment/worker): Running, ready 0/1, 2 restarts; worker last exited 1 (Error)",
  ],
  k8s_events: ["BackOff on Pod/worker-f5f4bfbf4-99qzx in app, 3 times, last 1 second ago: Back-off restarting"],
});

/** The same crash loop a minute later: a new pod name, more restarts, a later event. */
const CRASH_LOOP_LATER = triage({
  k8s_pods: [
    "1 of 2 pods unhealthy",
    "app/worker-f5f4bfbf4-7k2mz (Deployment/worker): Running, ready 0/1, 5 restarts; worker last exited 1 (Error)",
  ],
  k8s_events: ["BackOff on Pod/worker-f5f4bfbf4-7k2mz in app, 9 times, last 4 seconds ago: Back-off restarting"],
});

const LOCK_WAIT = triage({ pg_blocking: ["1 session waiting on locks; root blockers: pid 4242"] });
const HEALTHY = triage({});

/** Runs checks in sequence, one minute apart, and returns every action and the final state. */
function run(checks: readonly Triage[], policy = POLICY, start: State = initialState) {
  let state = start;
  const actions = checks.map((check, minute) => {
    const result = step(state, findingsOf(check), minutesLater(minute), policy);
    state = result.state;
    return result.actions;
  });
  return { actions, state };
}

describe("fingerprint", () => {
  it("is the same for one problem whose counts, ages, timestamps and pod names change", () => {
    const [first, later] = [CRASH_LOOP, CRASH_LOOP_LATER].map((check) =>
      findingsOf(check).map((finding) => finding.fingerprint),
    );
    expect(later).toEqual(first);
  });

  it("keeps words that only look like a pod suffix, and treats a span crossing units as the same", () => {
    expect(fingerprint("redis_health", "redis-cache is full")).toBe("redis_health: redis-cache is full");
    expect(fingerprint("k8s_certificates", "app/api-tls: expires in 1 hour")).toBe(
      fingerprint("k8s_certificates", "app/api-tls: expires in 59 minutes"),
    );
  });

  it("tells different problems apart", () => {
    expect(fingerprint("k8s_pods", "worker last exited 1 (Error)")).not.toBe(
      fingerprint("k8s_pods", "worker last exited 137 (OOMKilled)"),
    );
  });
});

describe("findingsOf", () => {
  it("counts a check that could not run as a finding, but not software the stack does not run", () => {
    const down: Triage = {
      problems: {},
      clean: [],
      unavailable: { pg_blocking: "failed; run pg_blocking for details" },
      not_installed: { k8s_certificates: "cert-manager is not installed in this cluster" },
    };
    expect(findingsOf(down).map((finding) => `${finding.tool}: ${finding.text}`)).toEqual([
      "pg_blocking: could not run: failed; run pg_blocking for details",
    ]);
  });

  it("treats a check timing out after a different number of milliseconds as the same finding", () => {
    const timedOut = (ms: number): Triage => ({
      problems: {},
      clean: [],
      unavailable: { redis_health: `did not finish within ${ms}ms` },
      not_installed: {},
    });
    expect(findingsOf(timedOut(8_000))[0]?.fingerprint).toBe(findingsOf(timedOut(10_000))[0]?.fingerprint);
  });

  it("skips ops_triage's '…and N more' line", () => {
    const capped = triage({ k8s_pods: ["app/a-1: Pending", "…and 4 more: see k8s_pods"] });
    expect(findingsOf(capped).map((finding: Finding) => finding.text)).toEqual(["app/a-1: Pending"]);
  });
});

describe("step", () => {
  it("investigates the problems of a new incident once, as one investigation", () => {
    const { actions } = run([CRASH_LOOP, CRASH_LOOP_LATER, CRASH_LOOP]);
    expect(actions[0]).toEqual([expect.objectContaining({ kind: "investigate", incident: 1 })]);
    expect(actions[0]?.[0]?.findings).toHaveLength(3);
    expect(actions.slice(1)).toEqual([[], []]);
  });

  it("opens a separate incident for a problem that appears while another is open", () => {
    const both = triage({ ...CRASH_LOOP.problems, ...LOCK_WAIT.problems });
    const { actions } = run([CRASH_LOOP, both]);
    expect(actions[1]).toEqual([expect.objectContaining({ kind: "investigate", incident: 2 })]);
    expect(actions[1]?.[0]?.findings.map((finding) => finding.tool)).toEqual(["pg_blocking"]);
  });

  it("resolves an incident once its problems are gone for enough checks in a row, and reopens it as new", () => {
    const { actions } = run([LOCK_WAIT, HEALTHY, HEALTHY, HEALTHY, LOCK_WAIT]);
    expect(actions[1]).toEqual([]);
    expect(actions[2]).toEqual([]);
    expect(actions[3]).toEqual([expect.objectContaining({ kind: "resolved", incident: 1 })]);
    expect(actions[4]).toEqual([expect.objectContaining({ kind: "investigate", incident: 2 })]);
  });

  it("does not resolve an incident whose problem flickers", () => {
    const { actions } = run([LOCK_WAIT, HEALTHY, HEALTHY, LOCK_WAIT, HEALTHY, HEALTHY]);
    expect(actions.flat()).toEqual([expect.objectContaining({ kind: "investigate", incident: 1 })]);
  });

  it("ignores accepted problems, case-insensitively", () => {
    const noLimit = triage({ redis_health: ["no maxmemory limit: Redis grows until the container runs out"] });
    const { actions } = run([noLimit], { ...POLICY, ignore: ["No MaxMemory Limit"] });
    expect(actions).toEqual([[]]);
  });

  it("records an incident without investigating it once the hourly budget is spent", () => {
    const tight = { ...POLICY, maxPerHour: 1 };
    const { actions } = run([LOCK_WAIT, HEALTHY, HEALTHY, HEALTHY, LOCK_WAIT], tight);
    expect(actions[4]).toEqual([
      expect.objectContaining({ kind: "over_budget", incident: 2, reason: expect.stringMatching(/last hour/) }),
    ]);
  });

  it("investigates again once the hour has passed", () => {
    const tight = { ...POLICY, maxPerHour: 1, resolveAfterChecks: 1 };
    const first = step(initialState, findingsOf(LOCK_WAIT), T0, tight);
    const gone = step(first.state, [], minutesLater(1), tight);
    const later = step(gone.state, findingsOf(LOCK_WAIT), minutesLater(61), tight);
    expect(later.actions).toEqual([expect.objectContaining({ kind: "investigate", incident: 2 })]);
  });

  it("stops at the daily budget too", () => {
    const daily = { ...POLICY, maxPerHour: 100, maxPerDay: 1, resolveAfterChecks: 1 };
    const { actions } = run([LOCK_WAIT, HEALTHY, LOCK_WAIT], daily);
    expect(actions[2]).toEqual([
      expect.objectContaining({ kind: "over_budget", reason: expect.stringMatching(/day/) }),
    ]);
  });
});
