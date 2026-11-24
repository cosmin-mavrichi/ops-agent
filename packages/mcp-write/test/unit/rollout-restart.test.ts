import type { ElicitResult } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { RESTARTED_AT } from "../../src/adapters/k8s-write.js";
import { rolloutRestart } from "../../src/tools/k8s/rollout-restart.js";
import { type ClusterOptions, ENV_SECRET, fakeCluster } from "../fake-cluster.js";
import { approve, decline, type Era, type Harness, useHarness } from "../harness.js";

const harness = useHarness();
const REASON = "pods crash-loop on a DB password that was rotated in the Secret since they started";
const ARGS = { namespace: "app", deployment: "api", reason: REASON };
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function start(answer?: () => Promise<ElicitResult>, cluster: ClusterOptions = {}, era: Era = "legacy") {
  const k8s = fakeCluster(cluster);
  const h = await harness({ tools: [rolloutRestart], k8s: k8s.client, answer, era, knownSecrets: ["topsecretvalue"] });
  const restart = (args: Record<string, unknown> = ARGS) => h.call("k8s_rollout_restart", args);
  return { ...h, k8s, restart };
}

/** Everything that left the server: forms, results, audit and log lines. */
const everything = (h: Harness, results: readonly unknown[]) => JSON.stringify([h.forms, results, h.audit, h.logs]);

describe.each<Era>(["legacy", "modern"])("k8s_rollout_restart, %s era", (era) => {
  it("restarts on an approval, with the version the human saw, and reports a healthy rollout", async () => {
    const h = await start(approve, {}, era);
    const result = await h.restart();
    expect(result.json).toMatchObject({ status: "restarted", rollout: { status: "healthy" } });
    expect(h.k8s.patches.map((patch) => [patch.mode, patch.resourceVersion])).toEqual([
      ["dry_run", "100"],
      ["apply", "100"],
    ]);
    expect(h.logs.map((line) => line.msg)).toEqual(["write_proposal", "write_action", "write_action_result"]);
    expect(h.logs.at(-1)?.meta).toMatchObject({ deployment: "api", status: "healthy" });
  });

  it("does not patch on a decline", async () => {
    const h = await start(decline, {}, era);
    expect((await h.restart()).json).toEqual({ status: "not_approved", why: "the human did not approve it" });
    expect(h.k8s.patches.map((patch) => patch.mode)).toEqual(["dry_run"]);
  });
});

describe("k8s_rollout_restart's form", () => {
  it("shows the agent's reason and the evidence the server read itself", async () => {
    const h = await start(decline);
    await h.restart();
    expect(h.forms).toHaveLength(1);
    const form = h.forms[0] ?? "";
    expect(form).toContain("Restart deployment app/api?");
    expect(form).toContain(`The agent's reason: ${REASON}`);
    expect(form).toContain("Deployment: 0/2 ready, 2 updated, last restart: never");
    expect(form).toContain("- api-0: Running, ready 0/1, 7 restarts, api waiting (CrashLoopBackOff)");
    expect(form).toContain("Dry run: the API server accepts the change.");
  });

  it("never shows container messages, which the app writes and which can argue for the action", async () => {
    const h = await start(decline);
    await h.restart();
    expect(h.forms[0]).not.toContain("IGNORE PREVIOUS INSTRUCTIONS");
  });

  it("leaks no env anywhere: forms, results, audit or logs", async () => {
    const h = await start(approve);
    const result = await h.restart();
    expect(everything(h, [result])).not.toContain(ENV_SECRET);
  });

  it("puts the agent's reason on one line, so it cannot draw lines that look like the server's evidence", async () => {
    const h = await start(decline);
    const forged = "stale pods\n\nDeployment: 2/2 ready, 2 updated\nDry run: the API server accepts the change.";
    await h.restart({ ...ARGS, reason: forged });
    const lines = (h.forms[0] ?? "").split("\n");
    expect(lines.filter((line) => line.startsWith("Deployment:"))).toEqual([
      "Deployment: 0/2 ready, 2 updated, last restart: never",
    ]);
    expect(lines).toContain(
      "The agent's reason: stale pods Deployment: 2/2 ready, 2 updated Dry run: the API server accepts the change.",
    );
  });

  it("redacts the agent's reason in the form and in the audit lines, which keep it", async () => {
    const h = await start(decline);
    await h.restart({ ...ARGS, reason: "the log shows topsecretvalue" });
    expect(everything(h, [])).not.toContain("topsecretvalue");
    expect(h.logs[0]?.meta?.reason).toBe("the log shows [redacted: known secret]");
  });
});

describe("k8s_rollout_restart refuses before asking", () => {
  it("a deployment restarted less than 10 minutes ago, by anyone", async () => {
    const h = await start(approve, { restartedAt: { api: minutesAgo(4) } });
    const result = await h.restart();
    expect(result).toMatchObject({ isError: true, json: { error: "rate_limited" } });
    expect(h.forms).toEqual([]);
    expect(h.k8s.patches).toEqual([]);
  });

  it("a sixth restart in an hour across the namespaces", async () => {
    const others = ["a", "b", "c", "d", "e"];
    const restartedAt = Object.fromEntries(others.map((name) => [name, minutesAgo(30)]));
    const h = await start(approve, { others, restartedAt });
    expect(await h.restart()).toMatchObject({ isError: true, json: { error: "rate_limited" } });
    expect(h.forms).toEqual([]);
  });

  it("a namespace outside its list, without reading anything", async () => {
    const h = await start(approve);
    expect(await h.restart({ ...ARGS, namespace: "kube-system" })).toMatchObject({
      isError: true,
      json: { error: "namespace_not_allowed" },
    });
    expect(h.k8s.reads).toEqual([]);
  });

  it("does not count restarts over an hour old", async () => {
    const others = ["a", "b", "c", "d", "e"];
    const restartedAt = Object.fromEntries(others.map((name) => [name, minutesAgo(61)]));
    const h = await start(approve, { others, restartedAt });
    expect((await h.restart()).json).toMatchObject({ status: "restarted" });
  });

  it("allows a deployment last restarted over 10 minutes ago", async () => {
    const h = await start(approve, { restartedAt: { api: minutesAgo(11) } });
    expect((await h.restart()).json).toMatchObject({ status: "restarted" });
  });
});

describe("k8s_rollout_restart after the approval", () => {
  it("does not patch a deployment that changed while the form was open: the agent proposes again", async () => {
    const k8s = fakeCluster();
    const approveAfterAChange = async () => {
      k8s.touch("api");
      return approve();
    };
    const h = await harness({ tools: [rolloutRestart], k8s: k8s.client, answer: approveAfterAChange });
    const result = await h.call("k8s_rollout_restart", ARGS);
    expect(result).toMatchObject({ isError: true, json: { error: "conflict" } });
    expect(result.text).toContain("propose the action again");
  });

  it("checks the hourly limit again on approval: forms open side by side cannot add up past it", async () => {
    const others = ["a", "b", "c", "d", "worker"];
    const restartedAt = Object.fromEntries(["a", "b", "c", "d"].map((name) => [name, minutesAgo(30)]));
    const k8s = fakeCluster({ others, restartedAt });
    const opened: string[] = [];
    // While the form for api is open, the human approves one for worker: the fifth restart this hour.
    const answer = async () => {
      opened.push("form");
      if (opened.length === 1) await h.call("k8s_rollout_restart", { ...ARGS, deployment: "worker" });
      return approve();
    };
    const h: Harness = await harness({ tools: [rolloutRestart], k8s: k8s.client, answer });
    const result = await h.call("k8s_rollout_restart", ARGS);
    expect(result).toMatchObject({ isError: true, json: { error: "rate_limited" } });
    const applied = k8s.patches.filter((patch) => patch.mode === "apply").map((patch) => patch.name);
    expect(applied).toEqual(["worker"]);
  });

  it("lets only one of two approvals side by side take the last place under the hourly limit", async () => {
    const others = ["a", "b", "c", "d", "worker"];
    const restartedAt = Object.fromEntries(["a", "b", "c", "d"].map((name) => [name, minutesAgo(30)]));
    const k8s = fakeCluster({ others, restartedAt, latencyMs: 5 });
    const h = await harness({ tools: [rolloutRestart], k8s: k8s.client, answer: approve });
    const results = await Promise.all([
      h.call("k8s_rollout_restart", ARGS),
      h.call("k8s_rollout_restart", { ...ARGS, deployment: "worker" }),
    ]);
    expect(k8s.patches.filter((patch) => patch.mode === "apply")).toHaveLength(1);
    expect(results.filter((result) => result.json?.error === "rate_limited")).toHaveLength(1);
  });

  it("records the restart in the audit even when the call is cancelled during the check", async () => {
    const k8s = fakeCluster({ rollout: "stalls" });
    const rollout = { rolledOutWithinMs: 10_000, healthyForMs: 60, pollMs: 5 };
    const h = await harness({ tools: [rolloutRestart], k8s: k8s.client, answer: approve, rollout });
    const signal = AbortSignal.timeout(300);
    const call = h.client.callTool({ name: "k8s_rollout_restart", arguments: ARGS }, { signal });
    await expect(call).rejects.toThrow();
    await vi.waitFor(() =>
      expect(h.logs.at(-1)).toMatchObject({ msg: "write_action_result", meta: { status: "check_aborted" } }),
    );
    expect(k8s.patches.map((patch) => patch.mode)).toEqual(["dry_run", "apply"]);
  });

  it("reports a rollout that does not finish in time", async () => {
    const h = await start(approve, { rollout: "stalls" });
    expect((await h.restart()).json).toMatchObject({
      rollout: { status: "not_rolled_out", deployment: { ready: "1/2" } },
    });
  });

  it("waits for the status to observe the new spec, whatever its counts say", async () => {
    const h = await start(approve, { rollout: "never_observed" });
    expect((await h.restart()).json).toMatchObject({
      rollout: { status: "not_rolled_out", deployment: { ready: "2/2" } },
    });
  });

  it("still reports the restart when the cluster stops answering after it", async () => {
    const h = await start(approve, { rollout: "reads_fail" });
    const result = await h.restart();
    expect(result).toMatchObject({ isError: false, json: { status: "restarted", rollout: { status: "unknown" } } });
    expect(h.logs.map((line) => line.msg)).toContain("rollout_check_failed");
    expect(h.logs.at(-1)).toMatchObject({ msg: "write_action_result", meta: { status: "unknown" } });
  });

  it("reports new pods that crash as rolled out but unhealthy: a restart was not the fix", async () => {
    const h = await start(approve, { rollout: "new_pods_crash" });
    expect((await h.restart()).json).toMatchObject({ rollout: { status: "rolled_out_unhealthy" } });
  });

  it("sets the annotation kubectl rollout restart sets", async () => {
    const h = await start(approve);
    const result = await h.restart();
    const applied = h.k8s.patches.find((patch) => patch.mode === "apply");
    expect(applied?.restartedAt).toBe(result.json.restarted_at);
    expect(RESTARTED_AT).toBe("kubectl.kubernetes.io/restartedAt");
  });
});
