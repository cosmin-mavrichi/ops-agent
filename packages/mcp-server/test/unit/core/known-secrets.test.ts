import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSecretsDir } from "../../../src/lib/known-secrets.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "known-secrets-"));
  dirs.push(dir);
  return dir;
}

/** The layout kubelet writes for a Secret volume: every key is a symlink into a hidden timestamped dir. */
function secretVolume(values: Record<string, string>): string {
  const dir = tempDir();
  const snapshot = "..2026_11_20_18_53_23.3764080150";
  mkdirSync(join(dir, snapshot));
  for (const [key, value] of Object.entries(values)) writeFileSync(join(dir, snapshot, key), value);
  symlinkSync(snapshot, join(dir, "..data"));
  for (const key of Object.keys(values)) symlinkSync(join("..data", key), join(dir, key));
  return dir;
}

describe("readSecretsDir", () => {
  it("reads every key of a Kubernetes Secret volume, through its symlinks", () => {
    const dir = secretVolume({ DB_PASSWORD: "lab-db-pw-5519", PAYMENT_API_KEY: "pk9Qz3Lm7Vx2Rt8Wb4Nc6Hd1" });
    expect(readSecretsDir(dir, () => {}).toSorted()).toEqual(["lab-db-pw-5519", "pk9Qz3Lm7Vx2Rt8Wb4Nc6Hd1"]);
  });

  it("reads plain files too, and ignores subdirectories", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "API_KEY"), "plain-file-secret");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "OTHER"), "not-read-secret");
    expect(readSecretsDir(dir, () => {})).toEqual(["plain-file-secret"]);
  });

  it("trims one trailing newline and nothing else", () => {
    const dir = secretVolume({ A: "with-newline-1\n", B: "with-crlf-22\r\n", C: "  spaces-kept  \n\n" });
    expect(readSecretsDir(dir, () => {}).toSorted()).toEqual(["  spaces-kept  \n", "with-crlf-22", "with-newline-1"]);
  });

  it("warns about values too short to redact, naming the file but never the value", () => {
    const warnings: string[] = [];
    const dir = secretVolume({ PIN: "4471\n", TOKEN: "long-enough-token" });
    expect(readSecretsDir(dir, (message) => warnings.push(message))).toEqual(["long-enough-token"]);
    expect(warnings).toEqual(['known secret "PIN" is shorter than 6 characters and will not be redacted']);
    expect(warnings.join("")).not.toContain("4471");
  });

  it("fails when the directory is missing, so a broken mount stops the boot", () => {
    expect(() => readSecretsDir(join(tempDir(), "missing"), () => {})).toThrow(/ENOENT/);
  });
});
