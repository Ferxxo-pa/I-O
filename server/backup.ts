import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_STAMP = "backup.json";
/** Nightly copy plus half a day, so one missed night is still green until the next. */
export const DEFAULT_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function dataDir(): string {
  return process.env.DATA_DIR || join(process.cwd(), "data");
}

export function backupStampPath(dir = dataDir()): string {
  return join(dir, BACKUP_STAMP);
}

export function readBackupStamp(dir = dataDir()): { at: number; dest?: string } | null {
  const file = backupStampPath(dir);
  if (!existsSync(file)) return null;
  try {
    const body = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown; dest?: unknown };
    if (typeof body.at !== "number" || !Number.isFinite(body.at)) return null;
    return { at: body.at, dest: typeof body.dest === "string" ? body.dest : undefined };
  } catch {
    return null;
  }
}

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function backupCheck(now = Date.now(), dir = dataDir()): { ok: boolean; detail: string; note?: string } {
  const stamp = readBackupStamp(dir);
  if (!stamp) return { ok: false, detail: "No backup yet" };
  const age = Math.max(0, now - stamp.at);
  const raw = process.env.BACKUP_MAX_AGE_MS;
  const max = raw && Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_BACKUP_MAX_AGE_MS;
  const label = formatAge(age);
  if (age > max) return { ok: false, detail: label };
  return { ok: true, detail: label, note: label };
}
