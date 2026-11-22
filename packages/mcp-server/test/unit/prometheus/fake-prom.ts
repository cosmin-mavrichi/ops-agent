import type { PromClient, PromSample } from "../../../src/types.js";

export const GIB = 1024 ** 3;

export type FakeSeries = Readonly<{
  used?: readonly PromSample[];
  capacity?: readonly PromSample[];
  inodesUsed?: readonly PromSample[];
  inodes?: readonly PromSample[];
  growth?: readonly PromSample[];
}>;

// Most specific first: the growth query also names used_bytes, and inodes_used starts like inodes.
const MATCHERS: ReadonlyArray<readonly [keyof FakeSeries, string]> = [
  ["growth", "deriv("],
  ["inodesUsed", "kubelet_volume_stats_inodes_used{"],
  ["inodes", "kubelet_volume_stats_inodes{"],
  ["used", "kubelet_volume_stats_used_bytes{"],
  ["capacity", "kubelet_volume_stats_capacity_bytes{"],
];

/** Fake query API that answers by metric and records every query it was sent. */
export function fakeProm(series: FakeSeries) {
  const queries: string[] = [];
  const client: PromClient = {
    query: async (promql) => {
      queries.push(promql);
      const metric = MATCHERS.find(([, needle]) => promql.includes(needle))?.[0];
      if (metric === undefined) throw new Error(`no fake series for ${promql}`);
      return [...(series[metric] ?? [])];
    },
  };
  return { client, queries };
}

export const claim = (namespace: string, pvc: string, value: number, extra: Record<string, string> = {}) => ({
  labels: { namespace, persistentvolumeclaim: pvc, ...extra },
  value,
});
