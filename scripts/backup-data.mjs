import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

if (!destRoot) {
  console.error("Set BACKUP_DIR to a second disk, a USB drive, or another folder.");
  process.exit(1);
}
if (!existsSync(dataDir)) {
  console.error(`DATA_DIR does not exist: ${dataDir}`);
  process.exit(1);
}

const day = new Date().toISOString().slice(0, 10);

function copyTree(dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(dataDir)) {
    if (name === "backup.json") continue;
    const from = join(dataDir, name);
    if (!statSync(from).isFile()) continue;
    cpSync(from, join(dest, name));
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
console.log(`backed up to ${copies.join(", ")}`);
