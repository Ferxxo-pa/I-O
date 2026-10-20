import { createDecipheriv } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

loadEnv(join(repo, ".env"));

const dataDir = process.env.DATA_DIR || join(repo, "data");
const destRoot = process.env.BACKUP_DIR?.trim();
const day = (process.env.BACKUP_DAY || process.argv[2] || "").trim();
const keyRaw = process.env.BACKUP_ENCRYPTION_KEY?.trim() ?? "";

if (!destRoot || !day) {
  console.error("Set BACKUP_DIR and pass the day folder, for example io-2026-10-19.");
  process.exit(1);
}

function keyBytes(value) {
  const buf = Buffer.from(value, "base64");
  if (buf.length !== 32) return null;
  return buf;
}

const key = keyBytes(keyRaw);
if (!key) {
  console.error("Set BACKUP_ENCRYPTION_KEY to the same 32-byte base64 key used for the copy. It lives in the shop .env, not on the USB drive.");
  process.exit(1);
}

const fromDir = join(destRoot, day.startsWith("io-") ? day : `io-${day}`);
if (!existsSync(fromDir)) {
  console.error(`No backup folder: ${fromDir}`);
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
let count = 0;
for (const name of readdirSync(fromDir)) {
  if (!name.endsWith(".enc")) continue;
  const raw = readFileSync(join(fromDir, name));
  if (raw.length < 4 + 12 + 16 || raw.subarray(0, 4).toString("utf8") !== "IOB1") {
    console.error(`Skipping ${name}. It is not an I/O backup.`);
    continue;
  }
  const iv = raw.subarray(4, 16);
  const tag = raw.subarray(16, 32);
  const ct = raw.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const dest = join(dataDir, name.slice(0, -4));
  writeFileSync(dest, plain);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // Windows uses deploy/windows/lock-secrets.cmd.
  }
  count += 1;
}
console.log(`restored ${count} files into ${dataDir}`);
