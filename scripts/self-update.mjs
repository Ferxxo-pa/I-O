import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checksumLine, checksumMatches, planUpdate, verifySignature } from "./update-lib.mjs";

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

function currentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function loadReleases() {
  const manifestUrl = process.env.UPDATE_MANIFEST_URL?.trim();
  if (manifestUrl) {
    const res = await fetch(manifestUrl);
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
  const repo = process.env.UPDATE_REPO?.trim() || "Ferxxo-pa/I-O";
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "io-update" },
  });
  if (!res.ok) throw new Error("Release fetch failed");
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const version = String(row.tag_name || "").replace(/^v/, "");
    const assets = Array.isArray(row.assets) ? row.assets : [];
    const asset = assets.find((item) => item.name === `io-${version}.tar.gz`);
    const sums = assets.find((item) => item.name === "SHA256SUMS");
    const sig = assets.find((item) => item.name === "SHA256SUMS.sig");
    return {
      version,
      draft: Boolean(row.draft),
      prerelease: Boolean(row.prerelease),
      asset: asset?.browser_download_url || "",
      sums: sums?.browser_download_url || "",
      signatureUrl: sig?.browser_download_url || "",
      sha256: "",
      signature: "",
    };
  });
}

function backupData() {
  if (process.env.BACKUP_ENCRYPTION_KEY?.trim() && process.env.BACKUP_DIR?.trim()) {
    const result = spawnSync(process.execPath, [join(root, "scripts", "backup-data.mjs")], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) throw new Error("Encrypted backup failed");
    return;
  }
  const data = process.env.DATA_DIR || join(root, "data");
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

async function readBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  return Buffer.from(await res.arrayBuffer());
}

function shaFromSums(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match && match[2] === filename) return match[1];
  }
  return "";
}

async function install(release) {
  const filename = `io-${release.version}.tar.gz`;
  const pubkey = process.env.UPDATE_TRUST_PUBKEY?.trim() ?? "";
  let sha = release.sha256 || "";
  let sumsText = "";
  if (release.sums) {
    sumsText = (await readBytes(release.sums)).toString("utf8");
    sha = shaFromSums(sumsText, filename) || sha;
  }
  if (!sha) throw new Error("Missing checksum");
  if (!sumsText) sumsText = checksumLine(sha, filename);
  if (pubkey) {
    let signature = release.signature ? Buffer.from(release.signature, "base64") : null;
    if (!signature && release.signatureUrl) signature = await readBytes(release.signatureUrl);
    if (!signature || !verifySignature(pubkey, sumsText, signature)) throw new Error("Bad signature");
  }
  const bytes = await readBytes(release.asset);
  if (!checksumMatches(sha, bytes)) throw new Error("Bad checksum");
  const incoming = join(root, "incoming");
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming, { recursive: true });
  const tarball = join(incoming, filename);
  writeFileSync(tarball, bytes);
  if (createHash("sha256").update(readFileSync(tarball)).digest("hex") !== sha.toLowerCase()) {
    throw new Error("Bad checksum");
  }
  backupData();
  const dist = join(root, "dist");
  const previous = join(root, "dist.previous");
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, previous);
  const extracted = spawnSync("tar", ["-xzf", tarball, "-C", root], { stdio: "inherit" });
  if (extracted.status !== 0 || !existsSync(dist)) {
    if (existsSync(previous)) {
      rmSync(dist, { recursive: true, force: true });
      renameSync(previous, dist);
    }
    throw new Error("Extract failed");
  }
  writeFileSync(join(root, "update-pending.json"), JSON.stringify({ version: release.version, at: Date.now() }));
  rmSync(incoming, { recursive: true, force: true });
  if (process.env.UPDATE_RESTART !== "0") {
    spawnSync("systemctl", ["restart", "io"], { stdio: "ignore" });
  }
}

const plan = planUpdate({
  enabled: process.env.UPDATE_ENABLED === "1",
  channel: process.env.UPDATE_CHANNEL || "stable",
  current: currentVersion(),
  releases: [],
  now: Date.now(),
  at: process.env.UPDATE_AT || "02:15",
  tz: process.env.UPDATE_TZ || "America/Chicago",
  windowMin: Number(process.env.UPDATE_WINDOW_MIN || "90"),
  applyNow: process.env.UPDATE_APPLY || "",
});

if (plan.action === "skip" && plan.reason === "disabled") {
  process.exit(0);
}

try {
  const releases = await loadReleases();
  const next = planUpdate({
    enabled: true,
    channel: process.env.UPDATE_CHANNEL || "stable",
    current: currentVersion(),
    releases,
    now: Date.now(),
    at: process.env.UPDATE_AT || "02:15",
    tz: process.env.UPDATE_TZ || "America/Chicago",
    windowMin: Number(process.env.UPDATE_WINDOW_MIN || "90"),
    applyNow: process.env.UPDATE_APPLY || "",
  });
  if (next.action !== "install") {
    process.exit(0);
  }
  await install(next.release);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Update failed");
  process.exit(1);
}
