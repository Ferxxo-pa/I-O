import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError, hashPin, pinShape, verifyPin } from "../auth/pin";

const MAX_FAILS = 6;
const LOCK_MS = 30_000;
const attempts = new Map<string, { fails: number; until: number }>();

export type PinFile = { version: 1; pins: Record<string, string> };

export function readPinFile(file: string): PinFile {
  if (!existsSync(file)) return { version: 1, pins: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pins?: Record<string, unknown> };
    const pins: Record<string, string> = {};
    for (const [id, hash] of Object.entries(parsed.pins ?? {})) {
      if (typeof hash === "string" && hash.startsWith("scrypt$")) pins[id] = hash;
    }
    return { version: 1, pins };
  } catch {
    return { version: 1, pins: {} };
  }
}

export function writePinHash(file: string, personId: string, pin: string): PinFile {
  if (!pinShape(pin)) throw new Error("PIN is 4 to 8 digits");
  const current = readPinFile(file);
  current.pins[personId] = hashPin(pin);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(current));
  return current;
}

export function resetPresencePinAttempts() {
  attempts.clear();
}

/** Check every hash so a match is not obvious from how fast we return. */
export function personIdForPin(pin: string, pins: Record<string, string>): string | null {
  if (!pinShape(pin)) return null;
  let found: string | null = null;
  for (const [id, hash] of Object.entries(pins)) {
    if (verifyPin(pin, hash)) found = id;
  }
  return found;
}

export function assertKnownPin(pin: string, pins: Record<string, string>, ip: string): string {
  const row = attempts.get(ip);
  if (row && row.until > Date.now()) throw new HttpError(429, "Too many tries");
  if (Object.keys(pins).length === 0) throw new HttpError(403, "Ask Ezven to set your PIN");
  const personId = personIdForPin(pin, pins);
  if (!personId) {
    const fails = (row && row.until === 0 ? row.fails : row?.until ? 0 : (row?.fails ?? 0)) + 1;
    if (fails >= MAX_FAILS) attempts.set(ip, { fails, until: Date.now() + LOCK_MS });
    else attempts.set(ip, { fails, until: 0 });
    throw new HttpError(fails >= MAX_FAILS ? 429 : 401, fails >= MAX_FAILS ? "Too many tries" : "Wrong PIN");
  }
  attempts.delete(ip);
  return personId;
}
