import { describe, expect, it } from "vitest";
import { createRedactor } from "../../../src/lib/redact.js";

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

  it("removes an app secret logged in free text, where no pattern applies", () => {
    const r = createRedactor(["lab-db-pw-5519", "pk9Qz3Lm7Vx2Rt8Wb4Nc6Hd1"]);
    expect(r("ERROR auth failed using lab-db-pw-5519")).toBe("ERROR auth failed using [redacted: known secret]");
    expect(r("WARN retrying with key pk9Qz3Lm7Vx2Rt8Wb4Nc6Hd1")).toBe(
      "WARN retrying with key [redacted: known secret]",
    );
  });

  it("keeps the known-secret marker when the secret sits where a pattern would also match", () => {
    // Otherwise key=value and PASSWORD '...' would turn the marker back into a plain [redacted], hiding the leak.
    const r = createRedactor(["lab-db-pw-5519"]);
    expect(r("DB_PASSWORD=lab-db-pw-5519")).toBe("DB_PASSWORD=[redacted: known secret]");
    expect(r("ALTER ROLE app PASSWORD 'lab-db-pw-5519'")).toBe("ALTER ROLE app PASSWORD '[redacted: known secret]'");
    expect(r("DB_PASSWORD=guessable1")).toBe("DB_PASSWORD=[redacted]");
  });

  it("matches known secrets literally, even with regex metacharacters", () => {
    const secret = "a.b*c+(d)?[e]$^|\\f";
    const r = createRedactor([secret]);
    expect(r(`using ${secret} now`)).toBe("using [redacted: known secret] now");
    expect(r("using aXbbbc+(d)?[e]$^|\\f now")).toBe("using aXbbbc+(d)?[e]$^|\\f now");
  });

  it("ignores very short 'known secrets' that would shred normal text", () => {
    const r = createRedactor(["ab"]);
    expect(r("table abc")).toBe("table abc");
  });
});
