import { createHash, timingSafeEqual, verify } from "node:crypto";

export function parseVersion(version) {
  const [core, pre = ""] = String(version).split("-");
  const nums = core.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre };
}

/** True when left is a newer version than right. A release sorts above its prerelease. */
export function versionNewer(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre > b.pre;
}

/**
 * stable is the newest non-draft release.
 * beta is the newest non-draft release, including prereleases.
 * Drafts are ignored. The result is newer than current, or null.
 */
export function chooseRelease(releases, channel, current) {
  const list = (Array.isArray(releases) ? releases : []).filter((row) => row && !row.draft && row.version);
  const pool = channel === "beta" ? list : list.filter((row) => !row.prerelease);
  let best = null;
  for (const row of pool) {
    if (!versionNewer(row.version, current || "0.0.0")) continue;
    if (!best || versionNewer(row.version, best.version)) best = row;
  }
  return best;
}

export function checksumMatches(hex, bytes) {
  if (typeof hex !== "string" || !/^[a-f0-9]{64}$/i.test(hex.trim())) return false;
  const digest = createHash("sha256").update(bytes).digest();
  const given = Buffer.from(hex.trim(), "hex");
  if (given.length !== digest.length) return false;
  return timingSafeEqual(given, digest);
}

/** Ed25519 over the checksum text. A bad key or a flipped byte returns false. */
export function verifySignature(publicKeyPem, message, signature) {
  try {
    const body = Buffer.isBuffer(message) ? message : Buffer.from(String(message));
    const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
    return verify(null, body, publicKeyPem, sig);
  } catch {
    return false;
  }
}

export function checksumLine(sha256, filename) {
  return `${sha256}  ${filename}\n`;
}

function zonedMinutes(now, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** True when local time is inside [HH:MM, HH:MM + windowMin). */
export function inInstallWindow(now, at, tz, windowMin) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!match) return false;
  const start = Number(match[1]) * 60 + Number(match[2]);
  if (start < 0 || start >= 24 * 60) return false;
  const span = Number(windowMin);
  if (!Number.isFinite(span) || span <= 0) return false;
  const cur = zonedMinutes(now, tz || "America/Chicago");
  const end = start + span;
  if (end <= 24 * 60) return cur >= start && cur < end;
  const wrapped = end % (24 * 60);
  return cur >= start || cur < wrapped;
}

/** After a swap, a failed health check rolls back once. A healthy boot commits. */
export function nextBootAction(pending, healthy) {
  if (!pending) return "ok";
  if (pending.rolledBack) return "ok";
  return healthy ? "ok" : "rollback";
}

export function planUpdate(input) {
  if (!input.enabled) return { action: "skip", reason: "disabled" };
  const release = chooseRelease(input.releases, input.channel === "beta" ? "beta" : "stable", input.current);
  if (!release) return { action: "skip", reason: "current" };
  if (input.applyNow !== "now" && !inInstallWindow(input.now, input.at, input.tz, input.windowMin)) {
    return { action: "wait", reason: "window", release };
  }
  return { action: "install", release };
}

/** One SHA256SUMS line. Two spaces, the same shape sha256sum writes. */
export function shaFromSums(text, filename) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match && match[2] === filename) return match[1];
  }
  return "";
}

/** Map the GitHub releases API into the rows the planner understands. */
export function githubReleases(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const version = String(row?.tag_name || "").replace(/^v/, "");
    const assets = Array.isArray(row?.assets) ? row.assets : [];
    const asset = assets.find((item) => item?.name === `io-${version}.tar.gz`);
    const sums = assets.find((item) => item?.name === "SHA256SUMS");
    const sig = assets.find((item) => item?.name === "SHA256SUMS.sig");
    return {
      version,
      draft: Boolean(row?.draft),
      prerelease: Boolean(row?.prerelease),
      asset: asset?.browser_download_url || "",
      sums: sums?.browser_download_url || "",
      signatureUrl: sig?.browser_download_url || "",
      sha256: "",
      signature: "",
      notes: typeof row?.body === "string" ? row.body : "",
    };
  });
}

export function releaseVersionOk(version) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(String(version || "").trim());
}

/**
 * PEM text, a one-line PEM with literal \n, or a path to a PEM file.
 * The private key never belongs here.
 */
export function readTrustKey(value, fs = null) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const unescaped = raw.replace(/\\n/g, "\n");
  if (unescaped.includes("BEGIN")) return unescaped;
  if (fs?.existsSync?.(raw)) {
    try {
      return String(fs.readFileSync(raw, "utf8"));
    } catch {
      return raw;
    }
  }
  return unescaped;
}

/** skip, windows (stop the shop node so the boot loop restarts it), or systemd. */
export function restartPlan(platform, env = {}) {
  if (env.UPDATE_RESTART === "0") return "skip";
  return platform === "win32" ? "windows" : "systemd";
}

/** Stop only the shop server. The updater process is left running. */
export function windowsServerStopScript(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Bad pid");
  return [
    `$self = ${id}`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" |",
    "Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -match 'dist[\\\\/]index\\.js' } |",
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
}
