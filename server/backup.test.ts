import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "io-backup-data-"));
const disk = mkdtempSync(join(tmpdir(), "io-backup-disk-"));
const cloud = mkdtempSync(join(tmpdir(), "io-backup-cloud-"));
const backupKey = randomBytes(32).toString("base64");
writeFileSync(join(data, "io-state.json"), '{"version":1}');
writeFileSync(join(data, "presence-punches.jsonl"), '{"id":"p1"}\n');
writeFileSync(join(data, "presence-phone.jsonl"), '{"id":"h1"}\n');
writeFileSync(join(data, ".env"), "SQUARE_ACCESS_TOKEN=should-not-copy\n");

const env = { ...process.env, DATA_DIR: data, BACKUP_DIR: disk, BACKUP_CLOUD_DIR: cloud, BACKUP_ENCRYPTION_KEY: backupKey };

const ran = spawnSync(process.execPath, ["scripts/backup-data.mjs"], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
});
assert.equal(ran.status, 0, ran.stderr);

const day = new Date().toISOString().slice(0, 10);
const encPath = join(disk, `io-${day}`, "io-state.json.enc");
const copied = readFileSync(encPath);
assert.equal(copied.subarray(0, 4).toString("utf8"), "IOB1");
assert.equal(copied.includes(Buffer.from('{"version":1}')), false);
assert.equal(statSync(encPath).mode & 0o777, 0o600);
const cloudEnc = readFileSync(join(cloud, `io-${day}`, "presence-phone.jsonl.enc"));
assert.equal(cloudEnc.includes(Buffer.from('{"id":"h1"}')), false);
assert.equal(existsSync(join(disk, `io-${day}`, ".env.enc")), false);

function decrypt(file: string): string {
  const raw = readFileSync(file);
  const key = Buffer.from(backupKey, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(4, 16));
  decipher.setAuthTag(raw.subarray(16, 32));
  return Buffer.concat([decipher.update(raw.subarray(32)), decipher.final()]).toString("utf8");
}

assert.equal(decrypt(encPath), '{"version":1}');
assert.equal(decrypt(join(disk, `io-${day}`, "presence-punches.jsonl.enc")), '{"id":"p1"}\n');
assert.equal(decrypt(join(cloud, `io-${day}`, "presence-phone.jsonl.enc")), '{"id":"h1"}\n');

const restored = mkdtempSync(join(tmpdir(), "io-backup-restored-"));
const back = spawnSync(process.execPath, ["scripts/restore-backup.mjs", `io-${day}`], {
  cwd: process.cwd(),
  env: { ...env, DATA_DIR: restored, BACKUP_CLOUD_DIR: "" },
  encoding: "utf8",
});
assert.equal(back.status, 0, back.stderr);
assert.equal(readFileSync(join(restored, "io-state.json"), "utf8"), '{"version":1}');
assert.equal(statSync(join(restored, "io-state.json")).mode & 0o777, 0o600);

const stamp = JSON.parse(readFileSync(join(data, "backup.json"), "utf8")) as { at: number; dest: string };
assert.ok(Date.now() - stamp.at < 60_000);
assert.match(stamp.dest, /io-\d{4}-\d{2}-\d{2}/);

process.env.DATA_DIR = data;
delete process.env.BACKUP_MAX_AGE_MS;
const { backupCheck, formatAge } = await import("./backup.ts");
const fresh = backupCheck(stamp.at + 2 * 3_600_000);
assert.equal(fresh.ok, true);
assert.equal(fresh.note, "2h ago");
const stale = backupCheck(stamp.at + 40 * 3_600_000);
assert.equal(stale.ok, false);
assert.equal(stale.detail, "40h ago");
assert.equal(formatAge(30_000), "Just now");

const empty = mkdtempSync(join(tmpdir(), "io-backup-empty-"));
process.env.DATA_DIR = empty;
const missing = backupCheck();
assert.equal(missing.ok, false);
assert.equal(missing.detail, "No backup yet");

const refused = spawnSync(process.execPath, ["scripts/backup-data.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: data, BACKUP_DIR: "", BACKUP_ENCRYPTION_KEY: backupKey },
  encoding: "utf8",
});
assert.notEqual(refused.status, 0);

const noKey = spawnSync(process.execPath, ["scripts/backup-data.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: data, BACKUP_DIR: disk, BACKUP_ENCRYPTION_KEY: "" },
  encoding: "utf8",
});
assert.notEqual(noKey.status, 0);
assert.match(noKey.stderr, /BACKUP_ENCRYPTION_KEY/);

console.log("backup ok");
