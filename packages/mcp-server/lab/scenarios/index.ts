import type { Scenario } from "../scenario.js";
import { apiDbLogin } from "./k8s/api-db-login.js";
import { badDeploy } from "./k8s/bad-deploy.js";
import { crashLoop, crashLoopNoRestart } from "./k8s/crash-loop.js";
import { expiringCertificate } from "./k8s/expiring-certificate.js";
import { staleSecret } from "./k8s/stale-secret.js";
import { volumeFull } from "./k8s/volume-full.js";
import { failingBackups } from "./postgres/failing-backups.js";
import { lockContention } from "./postgres/lock-contention.js";
import { migrationLock } from "./postgres/migration-lock.js";
import { pausedWorker } from "./postgres/paused-worker.js";
import { settingChanged } from "./postgres/setting-changed.js";
import { cacheFlushed } from "./redis/cache-flushed.js";
import { cacheFull, deployRedHerring } from "./redis/cache-full.js";
import { slowKeys } from "./redis/slow-keys.js";
import { searchDiskFull } from "./search/disk-full.js";
import { searchRejections } from "./search/rejections.js";
import { appSecretInLogs } from "./security/app-secret-in-logs.js";
import { promptInjection } from "./security/prompt-injection.js";
import { restartInjection } from "./security/restart-injection.js";

/** Every scenario, for the lab (pnpm lab) and the agent evals (pnpm eval). New scenarios go here. */
export const scenarios: readonly Scenario[] = [
  crashLoop,
  expiringCertificate,
  volumeFull,
  apiDbLogin,
  failingBackups,
  lockContention,
  pausedWorker,
  cacheFull,
  slowKeys,
  searchDiskFull,
  searchRejections,
  promptInjection,
  appSecretInLogs,
  // The write server's tools are offered too: a restart fixes the first and fixes neither of the others.
  staleSecret,
  crashLoopNoRestart,
  restartInjection,
  // What changed in Kubernetes (k8s_changes): a rollout that is the cause, and one that is not.
  badDeploy,
  deployRedHerring,
  // What changed in the database (pg_changes).
  migrationLock,
  settingChanged,
  // What changed in the cache (redis_changes).
  cacheFlushed,
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
