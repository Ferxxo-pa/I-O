import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "io-backup-data-"));
const disk = mkdtempSync(join(tmpdir(), "io-backup-disk-"));
const cloud = mkdtempSync(join(tmpdir(), "io-backup-cloud-"));
writeFileSync(join(data, "io-state.json"), '{"version":1}');
writeFileSync(join(data, "presence-punches.jsonl"), '{"id":"p1"}\n');
writeFileSync(join(data, "presence-phone.jsonl"), '{"id":"h1"}\n');

const ran = spawnSync(process.execPath, ["scripts/backup-data.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: data, BACKUP_DIR: disk, BACKUP_CLOUD_DIR: cloud },
  encoding: "utf8",
});
assert.equal(ran.status, 0, ran.stderr);

const day = new Date().toISOString().slice(0, 10);
const copied = readFileSync(join(disk, `io-${day}`, "io-state.json"), "utf8");
assert.equal(copied, '{"version":1}');
assert.equal(readFileSync(join(disk, `io-${day}`, "presence-punches.jsonl"), "utf8"), '{"id":"p1"}\n');
assert.equal(readFileSync(join(cloud, `io-${day}`, "presence-phone.jsonl"), "utf8"), '{"id":"h1"}\n');
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
  env: { ...process.env, DATA_DIR: data, BACKUP_DIR: "" },
  encoding: "utf8",
});
assert.notEqual(refused.status, 0);

console.log("backup ok");
