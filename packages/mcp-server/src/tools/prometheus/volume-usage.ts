import { z } from "zod";
import { describeSpan, formatBytes, HOUR_S } from "../../lib/units.js";
import { defineTool, Level, type PromClient, type PromSample } from "../../types.js";
import { allowedNamespaces, k8sLabel } from "../k8s/shared.js";

const GROWTH_WINDOW = "1h";
const FILL_WARNING_S = 48 * HOUR_S;
const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const NO_DATA =
  "No volume metrics for these namespaces. Either no PersistentVolumeClaim is mounted there, or Prometheus " +
  "does not scrape the kubelet (kubelet_volume_stats_*). Some volume types report no usage at all " +
  "(e.g. hostPath-based provisioners).";

/** kubelet_volume_stats_* per claim; `max` because several scrapes or replicas may report the same one. */
const QUERIES = {
  used: (match: string) => `kubelet_volume_stats_used_bytes{${match}}`,
  capacity: (match: string) => `kubelet_volume_stats_capacity_bytes{${match}}`,
  inodesUsed: (match: string) => `kubelet_volume_stats_inodes_used{${match}}`,
  inodes: (match: string) => `kubelet_volume_stats_inodes{${match}}`,
  growth: (match: string) => `deriv(kubelet_volume_stats_used_bytes{${match}}[${GROWTH_WINDOW}])`,
} as const;
type Metric = keyof typeof QUERIES;
type SeriesByMetric = Readonly<Record<Metric, readonly PromSample[]>>;

/** Namespaces go into PromQL. They come from the config allowlist, so check they are plain names. */
export function namespaceMatcher(namespaces: readonly string[]): string {
  const invalid = namespaces.find((namespace) => !K8S_NAME.test(namespace));
  if (invalid !== undefined) throw new Error(`not a Kubernetes namespace name: ${JSON.stringify(invalid)}`);
  return `namespace=~"${namespaces.join("|")}"`;
}

export const promql = (metric: Metric, matcher: string) =>
  `max by (namespace, persistentvolumeclaim) (${QUERIES[metric](matcher)})`;

export interface Volume {
  readonly namespace: string;
  readonly pvc: string;
  readonly used_bytes: number;
  readonly capacity_bytes: number;
  readonly used_pct: number;
  readonly inodes_used_pct: number | null;
  readonly growth_bytes_per_hour: number | null;
  readonly full_in_s: number | null;
  readonly problems: readonly string[];
}

const percent = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;
const claimKey = (labels: PromSample["labels"]) => `${labels.namespace}/${labels.persistentvolumeclaim}`;

function indexByClaim(samples: readonly PromSample[]): ReadonlyMap<string, number> {
  return new Map(samples.map((sample) => [claimKey(sample.labels), sample.value]));
}

function problemsOf(volume: Omit<Volume, "problems">, warnPct: number): string[] {
  const problems: string[] = [];
  if (volume.used_pct >= warnPct) {
    const used = `${formatBytes(volume.used_bytes)} of ${formatBytes(volume.capacity_bytes)}`;
    problems.push(`${volume.used_pct}% full (${used})`);
  }
  if (volume.inodes_used_pct !== null && volume.inodes_used_pct >= warnPct) {
    problems.push(`${volume.inodes_used_pct}% of inodes used: creating files fails even with space left`);
  }
  if (volume.full_in_s !== null && volume.full_in_s <= FILL_WARNING_S) {
    const rate = `${formatBytes(volume.growth_bytes_per_hour ?? 0)}/hour`;
    problems.push(`growing ${rate}: full in about ${describeSpan(volume.full_in_s)} at this rate`);
  }
  return problems;
}

/** Joins the per-metric series into one record per claim. Claims without a capacity are skipped. */
export function summarizeVolumes(series: SeriesByMetric, warnPct: number): Volume[] {
  const used = indexByClaim(series.used);
  const inodesUsed = indexByClaim(series.inodesUsed);
  const inodes = indexByClaim(series.inodes);
  const growth = indexByClaim(series.growth);

  return series.capacity.flatMap(({ labels, value: capacity }) => {
    const key = claimKey(labels);
    const usedBytes = used.get(key);
    if (usedBytes === undefined || capacity <= 0) return [];

    const inodeTotal = inodes.get(key);
    const inodeUsed = inodesUsed.get(key);
    const growthPerSecond = growth.get(key) ?? 0;
    const growing = growthPerSecond > 0;
    const measured = {
      namespace: labels.namespace ?? "",
      pvc: labels.persistentvolumeclaim ?? "",
      used_bytes: usedBytes,
      capacity_bytes: capacity,
      used_pct: percent(usedBytes, capacity),
      inodes_used_pct: inodeTotal && inodeUsed !== undefined ? percent(inodeUsed, inodeTotal) : null,
      growth_bytes_per_hour: growing ? Math.round(growthPerSecond * HOUR_S) : null,
      full_in_s: growing ? Math.round(Math.max(0, capacity - usedBytes) / growthPerSecond) : null,
    };
    return [{ ...measured, problems: problemsOf(measured, warnPct) }];
  });
}

const byUrgency = (a: Volume, b: Volume) => b.problems.length - a.problems.length || b.used_pct - a.used_pct;

async function queryAll(prom: PromClient, matcher: string, signal: AbortSignal): Promise<SeriesByMetric> {
  const run = (metric: Metric) => prom.query(promql(metric, matcher), signal);
  const [used, capacity, inodesUsed, inodes, growth] = await Promise.all([
    run("used"),
    run("capacity"),
    run("inodesUsed"),
    run("inodes"),
    run("growth"),
  ]);
  return { used, capacity, inodesUsed, inodes, growth };
}

export const promVolumeUsage = defineTool({
  name: "prom_volume_usage",
  level: Level.Read,
  requires: ["prom", "k8s"],
  title: "Volumes: disk usage of PersistentVolumeClaims",
  description:
    "Disk usage of each PersistentVolumeClaim, from the kubelet's metrics in Prometheus: used and capacity, " +
    "inodes, and how fast it is growing. Lists problems (nearly full, out of inodes, filling within two days) " +
    "and puts the fullest volumes first. Use it when writes fail (ENOSPC, 'No space left on device'), a " +
    "database stops accepting writes, or a pod is evicted.",
  input: {
    namespace: k8sLabel.optional(),
    warn_pct: z.number().int().min(50).max(99).default(85),
    limit: z.number().int().min(1).max(200).default(25),
  },
  timeoutMs: 8_000,

  async run({ namespace, warn_pct, limit }, { prom, k8s, signal }) {
    const matcher = namespaceMatcher(allowedNamespaces(k8s, namespace));
    const series = await queryAll(prom, matcher, signal);
    const volumes = summarizeVolumes(series, warn_pct).toSorted(byUrgency);
    if (volumes.length === 0) return { total: 0, volumes: [], note: NO_DATA };
    return { total: volumes.length, volumes: volumes.slice(0, limit) };
  },
});
