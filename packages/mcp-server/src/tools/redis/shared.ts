/** INFO output: `# Section` headers and `field:value` lines. Sections don't matter to callers. */
export function parseInfo(text: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1));
  }
  return fields;
}

/** `cmd=get,user=default,...` lists, as used by INFO errorstats/keyspace and CLIENT LIST. */
export function parsePairs(text: string, separator: "," | " "): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>();
  for (const part of text.split(separator)) {
    const equals = part.indexOf("=");
    if (equals > 0) pairs.set(part.slice(0, equals), part.slice(equals + 1));
  }
  return pairs;
}

/**
 * Key names often embed user ids, emails or tokens (`session:9f2c…`). Keeps the segments that are
 * short plain words and replaces the rest with `?`, so the shape survives: `user:?:profile`.
 * Long letter-only segments are masked too: random tokens can be letters only.
 */
export function maskKey(key: string): string {
  const isWord = (segment: string) => /^[A-Za-z_-]{1,24}$/.test(segment);
  return key
    .split(":")
    .map((segment) => (isWord(segment) ? segment : "?"))
    .join(":");
}
