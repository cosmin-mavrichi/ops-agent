/**
 * Last line of defence before anything reaches the model.
 * Tools should already avoid returning sensitive fields; this catches what slips through.
 */

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
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

export type Redactor = (text: string) => string;

/** Shorter known secrets are ignored: scrubbing them would also scrub common words. */
export const MIN_SECRET_LENGTH = 6;

/**
 * @param knownSecrets exact values to scrub (DB passwords, API keys from config).
 *        This is the most reliable rule: if we know the secret, we remove it verbatim.
 */
export function createRedactor(knownSecrets: string[] = []): Redactor {
  // So a secret that contains another is removed whole.
  const longestFirst = (a: string, b: string) => b.length - a.length;
  const exact = knownSecrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH).toSorted(longestFirst);

  return (input: string) => {
    let out = input;
    for (const secret of exact) out = out.replaceAll(secret, "***");
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  };
}
