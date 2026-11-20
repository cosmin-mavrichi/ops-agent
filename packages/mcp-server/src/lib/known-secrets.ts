import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MIN_SECRET_LENGTH } from "./redact.js";

/**
 * Reads secret values for redaction from a directory with one value per file, the layout of a
 * Kubernetes Secret volume. There, each key is a symlink (`DB_PASSWORD -> ..data/DB_PASSWORD`) and
 * the `..data` link and `..<timestamp>` directory hold the real files, so entries starting with `..`
 * are skipped and symlinks are followed.
 *
 * The values may only go to the redactor. `warn` never receives a value, only file names.
 */
export function readSecretsDir(dir: string, warn: (message: string) => void): string[] {
  const values: string[] = [];

  for (const name of readdirSync(dir)) {
    if (name.startsWith("..")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;

    // Files written with `echo` or `kubectl create secret --from-file` often end in a newline.
    const value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    if (value.length < MIN_SECRET_LENGTH) {
      warn(`known secret "${name}" is shorter than ${MIN_SECRET_LENGTH} characters and will not be redacted`);
      continue;
    }
    values.push(value);
  }
  return values;
}
