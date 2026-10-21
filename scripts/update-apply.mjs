import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  checksumLine,
  checksumMatches,
  githubReleases,
  readTrustKey,
  restartPlan,
  shaFromSums,
  verifySignature,
  windowsServerStopScript,
} from "./update-lib.mjs";

const LOCK_STALE_MS = 15 * 60 * 1000;

/** dist/version.json wins. The archive does not include package.json. */
export function currentVersion(root) {
  try {
    const stamped = JSON.parse(readFileSync(join(root, "dist", "version.json"), "utf8"));
    if (stamped && typeof stamped.version === "string" && stamped.version.trim()) return stamped.version.trim();
  } catch {
    // A shop that has never installed a release still uses package.json.
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function claimLock(root, now = Date.now(), staleMs = LOCK_STALE_MS) {
  const path = join(root, "update.lock");
  try {
    const stat = statSync(path);
    if (now - stat.mtimeMs < staleMs) return false;
    unlinkSync(path);
  } catch {
    // No lock yet.
  }
  try {
    const fd = openSync(path, "wx");
    writeFileSync(fd, String(now));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(root) {
  rmSync(join(root, "update.lock"), { force: true });
}

export function restorePreviousDist(root) {
  const previous = join(root, "dist.previous");
  const dist = join(root, "dist");
  if (!existsSync(previous)) return false;
  rmSync(dist, { recursive: true, force: true });
  renameSync(previous, dist);
  return true;
}

function backupData(root, env) {
  if (env.BACKUP_ENCRYPTION_KEY?.trim() && env.BACKUP_DIR?.trim()) {
    const result = spawnSync(process.execPath, [join(root, "scripts", "backup-data.mjs")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    if (result.status !== 0) throw new Error("Encrypted backup failed");
    return;
  }
  const data = env.DATA_DIR || join(root, "data");
  if (!existsSync(data)) return;
  const dest = join(root, "data.pre-update");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(data, dest, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop() || "";
      return base !== ".env" && base !== "backup.json";
    },
  });
}

async function readBytes(url, fetchBytes) {
  const bytes = await fetchBytes(url);
  if (!bytes || bytes.length === 0) throw new Error("Download failed");
  return Buffer.from(bytes);
}

export function performRestart(platform = process.platform, env = process.env) {
  const plan = restartPlan(platform, env);
  if (plan === "skip") return plan;
  if (plan === "windows") {
    const script = windowsServerStopScript(process.pid);
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
    return plan;
  }
  spawnSync("systemctl", ["restart", "io"], { stdio: "ignore" });
  return plan;
}

/**
 * Verify, back up, swap dist, and write update-pending.json.
 * A bad checksum or signature throws before dist moves.
 */
export async function installRelease({
  root,
  release,
  pubkey = "",
  fetchBytes,
  env = process.env,
  restart = true,
  platform = process.platform,
}) {
  const filename = `io-${release.version}.tar.gz`;
  const trust = readTrustKey(pubkey, { existsSync, readFileSync });
  let sha = release.sha256 || "";
  let sumsText = "";
  if (release.sums) {
    sumsText = (await readBytes(release.sums, fetchBytes)).toString("utf8");
    sha = shaFromSums(sumsText, filename) || sha;
  }
  if (!sha) throw new Error("Missing checksum");
  if (!sumsText) sumsText = checksumLine(sha, filename);
  if (trust) {
    let signature = release.signature ? Buffer.from(release.signature, "base64") : null;
    if (!signature && release.signatureUrl) signature = await readBytes(release.signatureUrl, fetchBytes);
    if (!signature || !verifySignature(trust, sumsText, signature)) throw new Error("Bad signature");
  }
  const bytes = await readBytes(release.asset, fetchBytes);
  if (!checksumMatches(sha, bytes)) throw new Error("Bad checksum");
  const incoming = join(root, "incoming");
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming, { recursive: true });
  const tarball = join(incoming, filename);
  writeFileSync(tarball, bytes);
  if (createHash("sha256").update(readFileSync(tarball)).digest("hex") !== sha.toLowerCase()) {
    throw new Error("Bad checksum");
  }
  backupData(root, env);
  const dist = join(root, "dist");
  const previous = join(root, "dist.previous");
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, previous);
  const extracted = spawnSync("tar", ["-xzf", tarball, "-C", root], { stdio: "inherit" });
  if (extracted.status !== 0 || !existsSync(dist)) {
    restorePreviousDist(root);
    throw new Error("Extract failed");
  }
  writeFileSync(join(root, "update-pending.json"), JSON.stringify({ version: release.version, at: Date.now() }));
  rmSync(incoming, { recursive: true, force: true });
  if (restart && env.UPDATE_RESTART !== "0") performRestart(platform, env);
}

export async function loadReleases(env, fetchImpl = globalThis.fetch) {
  const manifestUrl = env.UPDATE_MANIFEST_URL?.trim();
  if (manifestUrl) {
    const res = await fetchImpl(manifestUrl);
    if (!res.ok) throw new Error("Manifest fetch failed");
    const body = await res.json();
    const rows = Array.isArray(body) ? body : Array.isArray(body.releases) ? body.releases : [body];
    return rows
      .filter((row) => row && row.version && row.asset && row.sha256)
      .map((row) => ({
        version: String(row.version),
        draft: Boolean(row.draft),
        prerelease: Boolean(row.prerelease) || row.channel === "beta",
        asset: String(row.asset),
        sha256: String(row.sha256),
        signature: typeof row.signature === "string" ? row.signature : "",
        notes: typeof row.notes === "string" ? row.notes : "",
      }));
  }
  const repo = env.UPDATE_REPO?.trim() || "Ferxxo-pa/I-O";
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "io-update" },
  });
  if (!res.ok) throw new Error("Release fetch failed");
  return githubReleases(await res.json());
}
