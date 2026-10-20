import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type ReplayRow = {
  key: string;
  at: number;
  status: number;
  body: unknown;
  until?: number;
};

const hits = new Map<string, number[]>();
const deviceFails = new Map<string, { fails: number; until: number }>();

export function resetSignalLimits() {
  hits.clear();
  deviceFails.clear();
}

export function allowSignal(key: string, limit: number, now = Date.now(), windowMs = 60_000): boolean {
  const prev = (hits.get(key) ?? []).filter((ts) => now - ts < windowMs);
  if (prev.length >= limit) {
    hits.set(key, prev);
    return false;
  }
  prev.push(now);
  hits.set(key, prev);
  return true;
}

const DEVICE_FAILS = 8;
const DEVICE_LOCK_MS = 30_000;

export function noteDeviceFailure(ip: string, now = Date.now()): boolean {
  const row = deviceFails.get(ip);
  if (row && row.until > now) return true;
  const fails = (row && row.until > now ? row.fails : row?.until ? 0 : (row?.fails ?? 0)) + 1;
  if (fails >= DEVICE_FAILS) {
    deviceFails.set(ip, { fails, until: now + DEVICE_LOCK_MS });
    return true;
  }
  deviceFails.set(ip, { fails, until: 0 });
  return false;
}

export function deviceAuthLocked(ip: string, now = Date.now()): boolean {
  const row = deviceFails.get(ip);
  return Boolean(row && row.until > now);
}

export function clearDeviceFailures(ip: string) {
  deviceFails.delete(ip);
}

export function recallSignal(file: string, key: string): { status: number; body: unknown } | null {
  const row = readReplay(file).find((entry) => entry.key === key);
  if (!row) return null;
  return { status: row.status, body: row.body };
}

export function rememberSignal(file: string, key: string, status: number, body: unknown, now: number, keepMs: number) {
  const rows = readReplay(file).filter((entry) => {
    if (entry.key === key) return false;
    const until = typeof entry.until === "number" ? entry.until : entry.at + keepMs;
    return until > now;
  });
  rows.push({ key, at: now, status, body, until: now + keepMs });
  const capped = rows.slice(-2000);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, signals: capped }));
}

function readReplay(file: string): ReplayRow[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { signals?: ReplayRow[] };
    if (!Array.isArray(parsed.signals)) return [];
    return parsed.signals.filter((row) => typeof row.key === "string" && typeof row.status === "number");
  } catch {
    return [];
  }
}
