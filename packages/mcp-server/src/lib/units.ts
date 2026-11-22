export const MINUTE_S = 60;
export const HOUR_S = 60 * MINUTE_S;
export const DAY_S = 24 * HOUR_S;

export const toDays = (seconds: number) => Math.round((seconds / DAY_S) * 10) / 10;
const toHours = (seconds: number) => Math.round((seconds / HOUR_S) * 10) / 10;

function spanParts(seconds: number): readonly [number, string] {
  if (seconds >= DAY_S) return [toDays(seconds), "day"];
  if (seconds >= HOUR_S) return [toHours(seconds), "hour"];
  if (seconds >= MINUTE_S) return [Math.round(seconds / MINUTE_S), "minute"];
  return [Math.round(seconds), "second"];
}

/** In the largest unit that isn't zero: something an hour away is not "0 days" away. */
export function describeSpan(seconds: number): string {
  const [amount, unit] = spanParts(seconds);
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export function formatBytes(bytes: number): string {
  const exponent = Math.min(Math.floor(Math.log2(Math.max(bytes, 1)) / 10), BYTE_UNITS.length - 1);
  const scaled = Math.round((bytes / 1024 ** exponent) * 10) / 10;
  return `${scaled} ${BYTE_UNITS[exponent]}`;
}
