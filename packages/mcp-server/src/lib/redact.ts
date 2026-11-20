/**
 * Last line of defence before anything reaches the model.
 * Tools should already avoid returning sensitive fields; this catches what slips through.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // scheme://user:pass@host  (postgres, redis, amqp, https basic auth…)
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1***:***@"],
  // Authorization headers / bearer tokens
  [/\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  // JWTs
  [/\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}/gi, "***jwt***"],
  // SQL: PASSWORD 'literal'
  [/(password\s+)'(?:[^']|'')*'/gi, "$1'***'"],
  // key=value / key: value / "key":"value" for secret-ish keys (FOO_PASSWORD, MEILI_MASTER_KEY, api-key…)
  // Errs on the side of over-redacting (e.g. sort_key=…), which is the cheap mistake here.
  [
    /(["']?\b[a-z0-9_.-]*?(?:password|passwd|pwd|secret|token|credentials?|api[_-]?key|[_-]key)(?![a-z0-9])["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
    "$1***",
  ],
  // emails (user data in logs)
  [/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "***@***"],
];

export interface Redactor {
  (text: string): string;
}

/**
 * @param knownSecrets exact values to scrub (DB passwords, API keys from config).
 *        This is the most reliable rule: if we know the secret, we remove it verbatim.
 */
export function createRedactor(knownSecrets: string[] = []): Redactor {
  const exact = knownSecrets
    .filter((s) => s && s.length >= 6) // avoid scrubbing short common strings
    .sort((a, b) => b.length - a.length);

  return (input: string) => {
    let out = input;
    for (const s of exact) out = out.split(s).join("***");
    for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
    return out;
  };
}
