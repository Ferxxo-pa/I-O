import { createCipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const cloudRoot = process.env.BACKUP_CLOUD_DIR?.trim();
const keyRaw = process.env.BACKUP_ENCRYPTION_KEY?.trim() ?? "";

if (!destRoot) {
  console.error("Set BACKUP_DIR to a second disk, a USB drive, or another folder.");
  process.exit(1);
}
if (!existsSync(dataDir)) {
  console.error(`DATA_DIR does not exist: ${dataDir}`);
  process.exit(1);
}

function keyBytes(value) {
  const buf = Buffer.from(value, "base64");
  if (buf.length === 32 && Buffer.from(buf).toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")) return buf;
  return null;
}

const key = keyBytes(keyRaw);
if (!key) {
  console.error("Set BACKUP_ENCRYPTION_KEY to 32 random bytes, base64. Do not put that key on the USB drive.");
  process.exit(1);
}

const day = new Date().toISOString().slice(0, 10);

function encryptFile(from, to) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = readFileSync(from);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([Buffer.from("IOB1"), iv, tag, ct]);
  writeFileSync(to, out);
  try {
    chmodSync(to, 0o600);
  } catch {
    // Windows uses deploy/windows/lock-secrets.cmd.
  }
}

function copyTree(dest) {
  mkdirSync(dest, { recursive: true });
  try {
    chmodSync(dest, 0o700);
  } catch {
    // Best effort.
  }
  for (const name of readdirSync(dataDir)) {
    if (name === "backup.json" || name === ".env") continue;
    const from = join(dataDir, name);
    if (!statSync(from).isFile()) continue;
    encryptFile(from, join(dest, `${name}.enc`));
  }
}

function prune(rootDir) {
  if (!existsSync(rootDir)) return;
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  for (const name of readdirSync(rootDir)) {
    if (!/^io-\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const date = name.slice(3);
    if (date < cutoff) rmSync(join(rootDir, name), { recursive: true, force: true });
  }
}

const dest = join(destRoot, `io-${day}`);
copyTree(dest);
prune(destRoot);
const copies = [dest];
if (cloudRoot) {
  const cloud = join(cloudRoot, `io-${day}`);
  copyTree(cloud);
  prune(cloudRoot);
  copies.push(cloud);
}

const stamp = { at: Date.now(), dest: copies.join(", ") };
const stampPath = join(dataDir, "backup.json");
const tmp = `${stampPath}.tmp`;
writeFileSync(tmp, JSON.stringify(stamp));
renameSync(tmp, stampPath);
try {
  chmodSync(stampPath, 0o600);
} catch {
  // The stamp stays on the shop disk. It has no wages.
}
console.log(`backed up to ${copies.join(", ")}`);
