/** Disk watermarks: cluster.routing.allocation.disk.watermark.{low,high,flood_stage}. */
export const LEVELS = ["flood_stage", "high", "low"] as const;
export type WatermarkLevel = (typeof LEVELS)[number];

type Threshold =
  | { readonly kind: "used_pct"; readonly pct: number }
  | { readonly kind: "free_bytes"; readonly bytes: number };

export interface Watermark {
  readonly level: WatermarkLevel;
  /** As configured, e.g. "95%", "0.95" or "20gb" (free space). */
  readonly value: string;
  readonly threshold: Threshold;
  /** Elasticsearch only: on big disks the watermark applies once free space is below this. */
  readonly maxHeadroomBytes: number | undefined;
}

export interface Disk {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

type WatermarkSettings = Readonly<Record<string, string>>;
type SettingsSection = { cluster?: { routing?: { allocation?: { disk?: { watermark?: WatermarkSettings } } } } };
export type ClusterSettings = Readonly<Partial<Record<"defaults" | "persistent" | "transient", SettingsSection>>>;

const BYTE_FACTORS: Readonly<Record<string, number>> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

export function parseBytes(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const factor = BYTE_FACTORS[match[2].toLowerCase()];
  return factor === undefined ? undefined : Number(match[1]) * factor;
}

/** "95%" and "0.95" are used-space ratios; a byte size ("20gb") is the free space left. */
export function parseThreshold(value: string): Threshold | undefined {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (percent?.[1]) return { kind: "used_pct", pct: Number(percent[1]) };
  const ratio = /^(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(value.trim());
  if (ratio?.[1]) return { kind: "used_pct", pct: Number(ratio[1]) * 100 };
  const bytes = parseBytes(value);
  return bytes === undefined ? undefined : { kind: "free_bytes", bytes };
}

/**
 * The watermarks in force; transient settings override persistent ones, which override the defaults.
 * OpenSearch skips the low and high watermarks on a single data node unless enable_for_single_data_node is
 * true (there is nowhere to move shards to); flood stage still applies.
 */
export function watermarksFrom(settings: ClusterSettings, dataNodes: number): Watermark[] {
  const section = (name: keyof ClusterSettings) => settings[name]?.cluster?.routing?.allocation?.disk?.watermark;
  const merged: WatermarkSettings = { ...section("defaults"), ...section("persistent"), ...section("transient") };
  const singleNodeExempt = dataNodes === 1 && merged.enable_for_single_data_node === "false";
  const levels = singleNodeExempt ? (["flood_stage"] as const) : LEVELS;

  return levels.flatMap((level) => {
    const value = merged[level];
    const threshold = value === undefined ? undefined : parseThreshold(value);
    if (value === undefined || threshold === undefined) return [];
    const headroom = merged[`${level}.max_headroom`];
    const maxHeadroomBytes = headroom === undefined ? undefined : parseBytes(headroom);
    return [{ level, value, threshold, maxHeadroomBytes }];
  });
}

/** Whether the disk is past the watermark, the way the engine's disk threshold decider counts it. */
export function isPast(watermark: Watermark, disk: Disk): boolean {
  const { threshold, maxHeadroomBytes } = watermark;
  if (threshold.kind === "free_bytes") return disk.freeBytes < threshold.bytes;
  const minFree = disk.totalBytes * (1 - threshold.pct / 100);
  const pastHeadroom = maxHeadroomBytes === undefined || disk.freeBytes < maxHeadroomBytes;
  return disk.freeBytes < minFree && pastHeadroom;
}
