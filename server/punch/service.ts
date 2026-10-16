import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHOP_CLOCK } from "@shared/punch";
import { PunchBook } from "./book";
import { fenceFromEnv } from "./fence";
import { appendPunchLog, readPunchLog } from "./log";
import { hashPin, pinShape, verifyPin } from "./pin";
import { createPunchSink, punchSinkMode } from "./sink";

function dataDir(): string {
  return process.env.DATA_DIR || join(process.cwd(), "data");
}

function logFile(): string {
  return join(dataDir(), "punches.jsonl");
}

function pinFile(directory = dataDir()): string {
  return join(directory, "punch-pin.json");
}

let book: PunchBook | null = null;
let pinHash: string | null = null;
let loaded = false;
let envHash: string | null = null;
let envPinSeen: string | null = null;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  pinHash = readPinFile(dataDir());
}

export function readPinFile(directory: string): string | null {
  const file = pinFile(directory);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { hash?: string };
    if (typeof parsed.hash === "string" && parsed.hash.startsWith("scrypt$")) return parsed.hash;
  } catch {
    return null;
  }
  return null;
}

/** Persist a hash only. Returns the hash so tests can prove the PIN is absent. */
export function writePinFile(directory: string, pin: string): string {
  const hash = hashPin(pin);
  mkdirSync(directory, { recursive: true });
  writeFileSync(pinFile(directory), JSON.stringify({ hash }));
  return hash;
}

function envPinHash(): string | null {
  const pin = process.env.SHOP_PIN?.trim() ?? "";
  if (!pinShape(pin)) return null;
  if (envPinSeen !== pin || !envHash) {
    envPinSeen = pin;
    envHash = hashPin(pin);
  }
  return envHash;
}

export function punchPinSet(): boolean {
  ensureLoaded();
  return Boolean(pinHash || envPinHash());
}

export function checkPunchPin(pin: string): boolean {
  ensureLoaded();
  const stored = pinHash || envPinHash();
  if (!stored) return false;
  return verifyPin(pin, stored);
}

export function savePunchPin(pin: string) {
  pinHash = writePinFile(dataDir(), pin);
  loaded = true;
}

export function punchShopPublic() {
  const fence = fenceFromEnv();
  return {
    label: SHOP_CLOCK.label,
    address: SHOP_CLOCK.address,
    radiusM: fence.radiusM,
    mode: punchSinkMode(),
  };
}

export function getPunchBook(): PunchBook {
  ensureLoaded();
  if (book) return book;
  const file = logFile();
  book = new PunchBook({
    fence: fenceFromEnv(),
    sink: createPunchSink(),
    now: () => Date.now(),
    records: readPunchLog(file),
    append: (record) => appendPunchLog(file, record),
  });
  return book;
}
