import { describe, expect, it } from "vitest";
import { createRedactor } from "../../src/lib/redact.js";

const redact = createRedactor(["S3cr3t-DB-Pass!", "sk_live_abcdef123456"]);

// Each case: [description, input, secret that must NOT survive]
const cases: Array<[string, string, string]> = [
  ["known secret, verbatim", "connecting with S3cr3t-DB-Pass! failed", "S3cr3t-DB-Pass!"],
  ["known secret inside JSON", '{"key":"sk_live_abcdef123456"}', "sk_live_abcdef123456"],
  ["postgres URL", "error: postgres://app:hunter22@db:5432/app refused", "hunter22"],
  ["redis URL", "redis://default:r3dispw@redis:6379", "r3dispw"],
  ["bearer header", "Authorization: Bearer abcdefghijklmnop123", "abcdefghijklmnop123"],
  ["JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlX2hlcmU", "eyJzdWIiOiIxMjMifQ"],
  ["SQL password literal", "ALTER ROLE app PASSWORD 'pl41n''text'", "pl41n"],
  ["env-style key", "MEILI_MASTER_KEY=mk_9f8e7d6c5b4a", "mk_9f8e7d6c5b4a"],
  ["JSON secret key", '{"api_key": "abc123xyz789"}', "abc123xyz789"],
  ["user email", "login failed for maria.pop@example.ro", "maria.pop@example.ro"],
];

describe("redact", () => {
  it.each(cases)("%s", (_desc, input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  it("leaves ordinary diagnostics readable", () => {
    const line = "GET /api/reviews 504 in 30012ms (queue=reviews waiting=1203)";
    expect(redact(line)).toBe(line);
  });

  it("ignores very short 'known secrets' that would shred normal text", () => {
    const r = createRedactor(["ab"]);
    expect(r("table abc")).toBe("table abc");
  });
});
