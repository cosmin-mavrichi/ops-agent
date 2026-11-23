/** Request duration histograms as apps expose them, for prom_http_health's integration tests. */

export const PROM_CLIENT = "http_request_duration_seconds";
export const OTEL = "http_server_request_duration_seconds";
const BUCKETS = ["0.1", "0.5", "1", "2.5", "+Inf"] as const;
const MINUTE_S = 60;

export interface Traffic {
  readonly histogram: typeof PROM_CLIENT | typeof OTEL;
  readonly labels: string;
  readonly perSecond: number;
  /** Every request in this traffic takes about this long. */
  readonly seconds: number;
}

/** The histogram's samples after `count` requests; `at` (Unix seconds) timestamps them, as backfill needs. */
function histogramLines({ histogram, labels, seconds }: Traffic, count: number, at?: number): string[] {
  const suffix = at === undefined ? "" : ` ${at}`;
  const buckets = BUCKETS.map((le) => {
    const inBucket = le === "+Inf" || seconds <= Number(le) ? count : 0;
    return `${histogram}_bucket{${labels},le="${le}"} ${inBucket}${suffix}`;
  });
  const totals = [
    `${histogram}_count{${labels}} ${count}${suffix}`,
    `${histogram}_sum{${labels}} ${count * seconds}${suffix}`,
  ];
  return [...buckets, ...totals];
}

/** What the apps expose now: `perSecond` requests every second since `startedAt` (ms). For serveMetrics. */
export function liveMetrics(traffic: readonly Traffic[], startedAt: number): string {
  const secondsRunning = (Date.now() - startedAt) / 1000;
  const lines = traffic.flatMap((entry) => histogramLines(entry, Math.round(entry.perSecond * secondsRunning)));
  return `${lines.join("\n")}\n`;
}

/** OpenMetrics for promtool: one point a minute from `from` to `to` (Unix seconds), one family at a time. */
export function historyOf(traffic: readonly Traffic[], from: number, to: number): string {
  const minutes = Array.from({ length: Math.floor((to - from) / MINUTE_S) + 1 }, (_, index) => from + index * MINUTE_S);
  const seriesLines = (entry: Traffic) =>
    minutes.flatMap((at) => histogramLines(entry, Math.round(entry.perSecond * (at - from)), at));
  const familyLines = (histogram: Traffic["histogram"]) => {
    const series = traffic.filter((entry) => entry.histogram === histogram);
    return series.length === 0 ? [] : [`# TYPE ${histogram} histogram`, ...series.flatMap(seriesLines)];
  };
  return [...familyLines(PROM_CLIENT), ...familyLines(OTEL), "# EOF", ""].join("\n");
}
