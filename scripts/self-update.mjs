import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planUpdate, readTrustKey } from "./update-lib.mjs";
import { claimLock, currentVersion, installRelease, loadReleases, releaseLock } from "./update-apply.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function loadEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

loadEnv(join(root, ".env"));

const windowInput = {
  channel: process.env.UPDATE_CHANNEL || "stable",
  now: Date.now(),
  at: process.env.UPDATE_AT || "02:15",
  tz: process.env.UPDATE_TZ || "America/Chicago",
  windowMin: Number(process.env.UPDATE_WINDOW_MIN || "90"),
  applyNow: process.env.UPDATE_APPLY || "",
};

const plan = planUpdate({
  enabled: process.env.UPDATE_ENABLED === "1",
  current: currentVersion(root),
  releases: [],
  ...windowInput,
});

if (plan.action === "skip" && plan.reason === "disabled") {
  process.exit(0);
}

if (!claimLock(root)) {
  process.exit(0);
}

let code = 0;
try {
  const releases = await loadReleases(process.env);
  const next = planUpdate({
    enabled: true,
    current: currentVersion(root),
    releases,
    ...windowInput,
  });
  if (next.action === "install") {
    await installRelease({
      root,
      release: next.release,
      pubkey: readTrustKey(process.env.UPDATE_TRUST_PUBKEY, { existsSync, readFileSync }),
      env: process.env,
    });
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : "Update failed");
  code = 1;
} finally {
  releaseLock(root);
}
process.exit(code);
