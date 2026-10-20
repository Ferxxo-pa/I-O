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
