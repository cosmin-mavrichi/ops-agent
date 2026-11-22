import { describe, expect, it } from "vitest";
import { namespaceMatcher, promVolumeUsage, summarizeVolumes } from "../../../src/tools/prometheus/volume-usage.js";
import { useHarness } from "../../harness.js";
import { fakeK8s } from "../k8s/fake-k8s.js";
import { claim, type FakeSeries, fakeProm, GIB } from "./fake-prom.js";

const harness = useHarness();
const PLANTED = "planted-label-token-5821";

// app/db-data is 95% full; app/uploads is half full but grows 2 GiB an hour; jobs/scratch is fine.
const CLUSTER: FakeSeries = {
  capacity: [claim("app", "db-data", 10 * GIB), claim("app", "uploads", 100 * GIB), claim("jobs", "scratch", GIB)],
  used: [
    claim("app", "db-data", 9.5 * GIB, { pod_token: PLANTED }),
    claim("app", "uploads", 50 * GIB),
    claim("jobs", "scratch", 0.1 * GIB),
  ],
  inodes: [claim("app", "db-data", 1000), claim("app", "uploads", 1000)],
  inodesUsed: [claim("app", "db-data", 100), claim("app", "uploads", 990)],
  growth: [claim("app", "uploads", (2 * GIB) / 3600), claim("jobs", "scratch", -5)],
};

const empty = { used: [], capacity: [], inodesUsed: [], inodes: [], growth: [] };

describe("summarizeVolumes", () => {
  const volumes = summarizeVolumes({ ...empty, ...CLUSTER }, 85);
  const find = (pvc: string) => volumes.find((volume) => volume.pvc === pvc);

  it("reports a nearly full volume with its size", () => {
    expect(find("db-data")).toMatchObject({ used_pct: 95, problems: ["95% full (9.5 GiB of 10 GiB)"] });
  });

  it("warns about inodes and about a volume that will fill within two days", () => {
    expect(find("uploads")).toMatchObject({ inodes_used_pct: 99, growth_bytes_per_hour: 2 * GIB });
    expect(find("uploads")?.full_in_s).toBe(25 * 3600);
    expect(find("uploads")?.problems).toEqual([
      "99% of inodes used: creating files fails even with space left",
      "growing 2 GiB/hour: full in about 1 day at this rate",
    ]);
  });

  it("has no problems and no fill estimate for a small, shrinking volume", () => {
    expect(find("scratch")).toMatchObject({ problems: [], growth_bytes_per_hour: null, full_in_s: null });
    expect(find("scratch")?.inodes_used_pct).toBeNull();
  });

  it("skips a claim without a usage sample", () => {
    const onlyCapacity = summarizeVolumes({ ...empty, capacity: [claim("app", "new", GIB)] }, 85);
    expect(onlyCapacity).toEqual([]);
  });
});

describe("prom_volume_usage (unit)", () => {
  it("lists the volumes with problems first and never returns other labels", async () => {
    const prom = fakeProm(CLUSTER);
    const h = await harness({ tools: [promVolumeUsage], prom: prom.client, k8s: fakeK8s().client });
    const res = await h.call("prom_volume_usage");
    expect(res.isError, res.text).toBe(false);
    expect(res.json.volumes.map((volume: { pvc: string }) => volume.pvc)).toEqual(["uploads", "db-data", "scratch"]);
    expect(res.text).not.toContain(PLANTED);
    expect(res.text).not.toContain("pod_token");
  });

  it("asks only about the allowed namespaces, or the one requested", async () => {
    const prom = fakeProm(CLUSTER);
    const h = await harness({ tools: [promVolumeUsage], prom: prom.client, k8s: fakeK8s().client });
    await h.call("prom_volume_usage");
    await h.call("prom_volume_usage", { namespace: "jobs" });
    expect(prom.queries.slice(0, 5).every((query) => query.includes('namespace=~"app|jobs"'))).toBe(true);
    expect(prom.queries.slice(5).every((query) => query.includes('namespace=~"jobs"'))).toBe(true);
  });

  it("refuses a namespace outside the allowlist without querying", async () => {
    const prom = fakeProm(CLUSTER);
    const h = await harness({ tools: [promVolumeUsage], prom: prom.client, k8s: fakeK8s().client });
    const res = await h.call("prom_volume_usage", { namespace: "kube-system" });
    expect(res.json).toMatchObject({ error: "forbidden_namespace" });
    expect(prom.queries).toEqual([]);
  });

  it("explains an empty answer instead of reporting all is well", async () => {
    const h = await harness({ tools: [promVolumeUsage], prom: fakeProm({}).client, k8s: fakeK8s().client });
    const res = await h.call("prom_volume_usage");
    expect(res.json).toMatchObject({ total: 0, volumes: [] });
    expect(res.json.note).toContain("does not scrape the kubelet");
  });

  it("caps the list but reports the total", async () => {
    const h = await harness({ tools: [promVolumeUsage], prom: fakeProm(CLUSTER).client, k8s: fakeK8s().client });
    const res = await h.call("prom_volume_usage", { limit: 1 });
    expect(res.json.total).toBe(3);
    expect(res.json.volumes).toHaveLength(1);
  });
});

describe("namespaceMatcher", () => {
  it.each(['app"} or vector(1) #', "a|b", "App", ""])("refuses %j from the allowlist", (namespace) => {
    expect(() => namespaceMatcher([namespace])).toThrow(/not a Kubernetes namespace/);
  });
});
