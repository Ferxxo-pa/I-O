import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const MAX_FAILS = 6;
const LOCK_MS = 30_000;

const attempts = new Map<string, { fails: number; until: number }>();

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Shop PIN is 4 to 8 digits, same shape I/O already uses. */
export function pinShape(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

/** scrypt hash. The plaintext never goes into the saved book. */
export function hashPin(pin: string): string {
  if (!pinShape(pin)) throw new Error("PIN is 4 to 8 digits");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32, SCRYPT).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  if (!pinShape(pin)) return false;
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash || !/^[0-9a-f]+$/i.test(hash)) return false;
  const actual = Buffer.from(hash, "hex");
  const next = scryptSync(pin, salt, 32, SCRYPT);
  if (next.length !== actual.length || actual.length === 0) return false;
  return timingSafeEqual(next, actual);
}

export function pinLocked(ip: string, now = Date.now()): boolean {
  const row = attempts.get(ip);
  return Boolean(row && row.until > now);
}

function notePinFailure(ip: string, now = Date.now()): boolean {
  const row = attempts.get(ip);
  const base = row && row.until > now ? row.fails : row?.until ? 0 : (row?.fails ?? 0);
  const fails = base + 1;
  if (fails >= MAX_FAILS) {
    attempts.set(ip, { fails, until: now + LOCK_MS });
    return true;
  }
  attempts.set(ip, { fails, until: 0 });
  return false;
}

export function clearPinFailures(ip: string) {
  attempts.delete(ip);
}

/**
 * Header or body PIN. Locked clients get 429. A missing shop PIN is 403,
 * a wrong one is 401. The check is timing-safe and the pin is not logged.
 */
export function assertShopPin(
  header: string | undefined,
  ip: string,
  pinSet: boolean,
  check: (pin: string) => boolean,
): void {
  if (!pinSet) throw new HttpError(403, "Set a shop PIN");
  if (pinLocked(ip)) throw new HttpError(429, "Too many tries");
  const pin = header?.trim() ?? "";
  if (!check(pin)) {
    const locked = notePinFailure(ip);
    throw new HttpError(locked ? 429 : 401, locked ? "Too many tries" : "Wrong PIN");
  }
  clearPinFailures(ip);
}

/** Test hook. */
export function resetPinAttempts() {
  attempts.clear();
}
