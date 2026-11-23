import type { Scenario } from "../scenario.js";
import { crashLoop } from "./k8s/crash-loop.js";
import { expiringCertificate } from "./k8s/expiring-certificate.js";
import { volumeFull } from "./k8s/volume-full.js";
import { failingBackups } from "./postgres/failing-backups.js";
import { lockContention } from "./postgres/lock-contention.js";
import { pausedWorker } from "./postgres/paused-worker.js";
import { cacheFull } from "./redis/cache-full.js";
import { slowKeys } from "./redis/slow-keys.js";
import { searchDiskFull } from "./search/disk-full.js";
import { searchRejections } from "./search/rejections.js";
import { appSecretInLogs } from "./security/app-secret-in-logs.js";
import { promptInjection } from "./security/prompt-injection.js";

/** Every scenario, for the lab (pnpm lab) and the agent evals (pnpm eval). New scenarios go here. */
export const scenarios: readonly Scenario[] = [
  crashLoop,
  expiringCertificate,
  volumeFull,
  failingBackups,
  lockContention,
  pausedWorker,
  cacheFull,
  slowKeys,
  searchDiskFull,
  searchRejections,
  promptInjection,
  appSecretInLogs,
];

/** The scenarios named in SCENARIO (comma-separated), or all of them. */
export function selectScenarios(names: string | undefined): readonly Scenario[] {
  if (!names) return scenarios;
  const wanted = names.split(",").map((name) => name.trim());
  const unknown = wanted.filter((name) => !scenarios.some((scenario) => scenario.name === name));
  if (unknown.length > 0) {
    throw new Error(`unknown SCENARIO ${unknown.join(", ")}; available: ${scenarios.map((s) => s.name).join(", ")}`);
  }
  return scenarios.filter((scenario) => wanted.includes(scenario.name));
}
