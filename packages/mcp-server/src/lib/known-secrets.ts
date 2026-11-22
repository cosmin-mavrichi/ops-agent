import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MIN_SECRET_LENGTH } from "./redact.js";

interface SecretFile {
  readonly name: string;
  readonly value: string;
}

/** In a Secret volume, kubelet's own `..data` link and `..<timestamp>` directory hold the real files. */
const isSecretKey = (name: string) => !name.startsWith("..");

// Files written with `echo` or `kubectl create secret --from-file` often end in a newline.
const withoutTrailingNewline = (text: string) => text.replace(/\r?\n$/, "");

const isLongEnough = (secret: SecretFile) => secret.value.length >= MIN_SECRET_LENGTH;

/** One entry per regular file; statSync follows the key symlinks, and subdirectories are skipped. */
function secretFiles(dir: string): SecretFile[] {
  const entries = readdirSync(dir)
    .filter(isSecretKey)
    .map((name) => ({ name, path: join(dir, name) }));
  const files = entries.filter(({ path }) => statSync(path).isFile());
  return files.map(({ name, path }) => ({ name, value: withoutTrailingNewline(readFileSync(path, "utf8")) }));
}

/**
 * Reads secret values for redaction from a directory with one value per file, the layout of a
 * Kubernetes Secret volume, where each key is a symlink (`DB_PASSWORD -> ..data/DB_PASSWORD`).
 *
 * The values may only go to the redactor. `warn` never receives a value, only file names.
 */
export function readSecretsDir(dir: string, warn: (message: string) => void): string[] {
  const secrets = secretFiles(dir);
  const tooShort = secrets.filter((secret) => !isLongEnough(secret));
  for (const { name } of tooShort) {
    warn(`known secret "${name}" is shorter than ${MIN_SECRET_LENGTH} characters and will not be redacted`);
  }
  return secrets.filter(isLongEnough).map((secret) => secret.value);
}
