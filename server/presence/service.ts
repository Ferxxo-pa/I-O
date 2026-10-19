import { timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import { zonedParts } from "@shared/fight";
import { SHOP_PRESENCE, presenceReasonText, shopDateStart, type PresenceView, type PunchRecord, type PunchType } from "@shared/presence";
import { HttpError } from "../auth/pin";
import { earnEngine } from "../clock/engine";
import { getCompany } from "../company";
import type { ClockSignal, Correction, PunchEffect, PunchInput } from "./book";
import { PresenceBook } from "./book";
import { consentActive, readConsent, setConsent, type ConsentRow } from "./consent";
import { dayConfigFromEnv, signalConfigFromEnv } from "./config";
import {
  findLiveDevice,
  issueDevice,
  publicDevice,
  readDevices,
  revokeDevice,
  writeDeviceSession,
  type DeviceRow,
} from "./devices";
import { fenceFromEnv, shopLabel } from "./geo";
import { appendPunchLog, readPunchLog } from "./log";
import { readPinFile, writePinHash } from "./pins";
import {
  deviceHashPepper,
  findLiveRadio,
  publicRadio,
  readRadios,
  revokeRadio,
  upsertRadio,
  writeRadioSession,
  type RadioKind,
  type RadioRow,
} from "./radios";
import { allowSignal, clearDeviceFailures, deviceAuthLocked, noteDeviceFailure, recallSignal, rememberSignal } from "./replay";
import { blankSession, type SessionState } from "./session";
import { liveTransport, mirrorMode, type MirrorLink, type MirrorTransport, type PlannedCall, type SquarePerson } from "./square";
import { latchedOvernight } from "./session";
import { deviceLatched, dropPhoneLatches, shouldAutoClose, shouldQuietLeave, type WatchPerson } from "./watch";

type RosterPerson = { id: string; name: string; hourlyCents: number };

let book: PresenceBook | null = null;
let squarePeople: SquarePerson[] = [];
let previewNow: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
const listeners = new Set<Response>();

function dataDir(): string {
  return process.env.DATA_DIR || join(process.cwd(), "data");
}

function punchFile(): string {
  return join(dataDir(), "presence-punches.jsonl");
}

function pinPath(): string {
  return join(dataDir(), "presence-pins.json");
}

function correctionFile(): string {
  return join(dataDir(), "presence-corrections.jsonl");
}

function mirrorFile(): string {
  return join(dataDir(), "presence-mirror.json");
}

function squareFile(): string {
  return join(dataDir(), "presence-square.json");
}

function dryFile(): string {
  return join(dataDir(), "presence-square-dry.jsonl");
}

function deviceFile(): string {
  return join(dataDir(), "presence-devices.json");
}

function wifiFile(): string {
  return join(dataDir(), "presence-wifi.json");
}

function beaconFile(): string {
  return join(dataDir(), "presence-beacons.json");
}

function consentFile(): string {
  return join(dataDir(), "presence-consent.json");
}

function watchFile(): string {
  return join(dataDir(), "presence-watch.json");
}

function replayFile(): string {
  return join(dataDir(), "presence-replay.json");
}

export function presenceNow(): number {
  return previewNow ?? Date.now();
}

export function previewEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.PRESENCE_PREVIEW === "1";
}

export function setPreviewNow(ts: number | null) {
  if (!previewEnabled()) throw new Error("Not found");
  previewNow = ts;
}

export function deskAuthorized(presented: string | undefined): boolean {
  const expected = process.env.PRESENCE_DESK_TOKEN?.trim() ?? "";
  const given = presented?.trim() ?? "";
  if (!expected || !given) return false;
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function roster(): RosterPerson[] {
  return getCompany().people.map((person) => ({
    id: person.id,
    name: person.name,
    hourlyCents: person.hourlyCents,
  }));
}

function readCorrections(): Correction[] {
  const file = correctionFile();
  if (!existsSync(file)) return [];
  const rows: Correction[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Correction;
      if (row.id && row.personId && (row.status === "pending" || row.status === "approved" || row.status === "denied")) {
        rows.push(row);
      }
    } catch {
      // Leave the bad line in place.
    }
  }
  return rows;
}

function readLinks(): MirrorLink[] {
  const file = mirrorFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { links?: MirrorLink[] };
    return Array.isArray(parsed.links) ? parsed.links : [];
  } catch {
    return [];
  }
}

function writeLinks(links: MirrorLink[]) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(mirrorFile(), JSON.stringify({ links }));
}

function loadSquarePeople(): SquarePerson[] {
  const file = squareFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { people?: SquarePerson[] };
    return Array.isArray(parsed.people) ? parsed.people : [];
  } catch {
    return [];
  }
}

function transport(): MirrorTransport {
  if (mirrorMode() !== "live") return { mode: "dry_run", request: async () => ({}) };
  return liveTransport();
}

function ensureBook(): PresenceBook {
  if (book) return book;
  squarePeople = loadSquarePeople();
  const links = readLinks();
  book = new PresenceBook({
    config: dayConfigFromEnv(),
    fence: fenceFromEnv(),
    now: presenceNow,
    records: readPunchLog(punchFile()),
    corrections: readCorrections(),
    links,
    squarePeople,
    locationId: process.env.SQUARE_LOCATION_ID?.trim() || getCompany().locationId || "local",
    append: (record) => appendPunchLog(punchFile(), record),
    appendCorrection: (row) => {
      mkdirSync(dataDir(), { recursive: true });
      appendFileSync(correctionFile(), `${JSON.stringify(row)}\n`);
    },
    saveLink: (link) => {
      const next = links.filter((entry) => !(entry.personId === link.personId && entry.date === link.date));
      next.push(link);
      links.splice(0, links.length, ...next);
      writeLinks(links);
    },
    transport,
  });
  return book;
}

function rateFor(personId: string): number {
  return roster().find((person) => person.id === personId)?.hourlyCents || earnEngine.getState().config.hourlyOutputCents;
}

function applySignal(signal: ClockSignal) {
  if (!earnEngine.presenceMayDrive(signal.personId)) return;
  const person = { id: signal.personId, name: signal.name, hourlyCents: rateFor(signal.personId) };
  if (signal.phase === "working") {
    if (!earnEngine.shiftOpen(signal.personId)) earnEngine.beginWork(person);
    else earnEngine.releaseHold(signal.personId);
    return;
  }
  if (signal.phase === "pending" && signal.leaveTs != null) {
    if (!earnEngine.shiftOpen(signal.personId)) earnEngine.beginWork(person);
    earnEngine.holdWork(signal.personId, signal.leaveTs);
    return;
  }
  if (signal.phase === "break" && signal.leaveTs != null) {
    earnEngine.endWorkAt(signal.personId, signal.leaveTs);
    return;
  }
  if (signal.phase === "closed") {
    earnEngine.endWorkAt(signal.personId, signal.closedAt ?? signal.leaveTs ?? presenceNow());
  }
}

function applyAll() {
  for (const signal of ensureBook().signals(roster(), presenceNow())) applySignal(signal);
}

function rememberPlan(planned: PlannedCall[]) {
  if (planned.length === 0) return;
  mkdirSync(dataDir(), { recursive: true });
  for (const call of planned) {
    appendFileSync(dryFile(), `${JSON.stringify({ at: presenceNow(), mode: mirrorMode(), ...call })}\n`);
  }
}

function clearPhoneLatch(personId: string, deviceId: string, at: number) {
  const watch = watchFor(personId);
  if (!watch) return;
  saveWatch(personId, dropPhoneLatches(watch, deviceId, at));
}

async function releaseStationary() {
  const now = presenceNow();
  const signal = signalConfigFromEnv();
  const day = dayConfigFromEnv();
  for (const device of readDevices(deviceFile())) {
    if (device.revokedAt != null || device.stationaryAt != null || device.sessionStart == null) continue;
    if (!deviceLatched(watchFor(device.personId), device.id, now, signal.quietMs)) continue;
    const tooLong = now - device.sessionStart >= signal.stationaryMs;
    const overnight = latchedOvernight(device.sessionStart, now, day.tz);
    if (!tooLong && !overnight) continue;
    saveDeviceSession(device.id, { sessionStart: device.sessionStart, lastSeenAt: now, stationaryAt: now });
    clearPhoneLatch(device.personId, device.id, now);
    const person = roster().find((entry) => entry.id === device.personId);
    if (!person) continue;
    const today = ensureBook().day(person.id, now);
    let ts = now;
    if (today.phase !== "working") {
      if (!overnight) continue;
      const sessionDate = zonedParts(device.sessionStart, day.tz).key;
      const autoCloseAt = shopDateStart(sessionDate, day.tz) + signal.autoCloseMin * 60_000;
      ts = Math.min(now, Math.max(device.sessionStart, autoCloseAt));
    }
    await commitNote({
      person,
      type: "leave",
      ts,
      source: "stationary",
      flag: "stationary",
      closesDay: true,
    });
  }
}

async function maintain() {
  const now = presenceNow();
  const signal = signalConfigFromEnv();
  const current = ensureBook();
  const day = current.config();
  const date = zonedParts(now, day.tz).key;
  const deadline = shopDateStart(date, day.tz) + signal.autoCloseMin * 60_000;
  await releaseStationary();
  for (const person of roster()) {
    try {
      const watch = watchFor(person.id);
      let status = current.day(person.id, now);
      const quietAt = shouldQuietLeave({
        phase: status.phase,
        clockInTs: status.clockInTs,
        watch,
        now,
        quietMs: signal.quietMs,
      });
      if (quietAt != null) {
        await commitNote({
          person,
          type: "leave",
          ts: quietAt,
          source: "quiet",
        });
        status = current.day(person.id, now);
      }
      const closeAt = shouldAutoClose({
        phase: status.phase,
        clockInTs: status.clockInTs,
        watch: watchFor(person.id),
        now,
        autoCloseAt: deadline,
        quietMs: signal.quietMs,
      });
      if (closeAt != null) {
        await commitNote({
          person,
          type: "leave",
          ts: closeAt,
          source: "auto_close",
          closesDay: true,
          flag: "auto_closed",
        });
        const fresh = watchFor(person.id);
        if (fresh) {
          let next = fresh;
          for (const key of Object.keys(fresh.sources)) {
            if (!key.startsWith("phone:") || !fresh.sources[key]?.present) continue;
            const sourceId = key.slice("phone:".length);
            const deviceId = sourceId.split(":")[0] ?? "";
            if (deviceId) next = dropPhoneLatches(next, deviceId, closeAt);
          }
          saveWatch(person.id, next);
        }
      }
    } catch {
      // The next sweep tries this person again.
    }
  }
}

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await maintain();
    const current = ensureBook();
    const planned = await current.mirror(
      roster().map((person) => person.id),
      presenceNow(),
    );
    rememberPlan(planned);
    applyAll();
  } finally {
    sweeping = false;
  }
}

export async function catchUpPresence() {
  await sweep();
}

export function startPresence() {
  ensureBook();
  earnEngine.setPresenceProvider((viewerId) => ensureBook().view(roster(), viewerId, presenceNow()));
  if (timer) return;
  timer = setInterval(() => {
    void sweep();
  }, 1000);
  timer.unref();
}

export function stopPresence() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const res of Array.from(listeners)) res.end();
  listeners.clear();
}

export function presencePins(): Record<string, string> {
  ensureBook();
  return readPinFile(pinPath()).pins;
}

export function savePersonPin(personId: string, pin: string) {
  if (!roster().some((person) => person.id === personId)) throw new Error("That person is not on this business");
  writePinHash(pinPath(), personId, pin);
}

export function saveSquarePeople(people: SquarePerson[]) {
  squarePeople.splice(0, squarePeople.length, ...people);
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(squareFile(), JSON.stringify({ people: squarePeople }));
}

export function squarePeopleView(): SquarePerson[] {
  ensureBook();
  return squarePeople.map((person) => ({ ...person }));
}

export function presenceView(viewerId: string | null): PresenceView {
  return ensureBook().view(roster(), viewerId, presenceNow());
}

export function presenceLog(): { punches: PunchRecord[]; corrections: Correction[] } {
  const current = ensureBook();
  return { punches: current.list().slice().reverse(), corrections: current.correctionList() };
}

export function shopPublic() {
  return shopLabel();
}

export function personHasConsent(personId: string): boolean {
  return consentActive(readConsent(consentFile()), personId);
}

export function saveConsent(personId: string, consent: boolean): ConsentRow {
  if (!roster().some((person) => person.id === personId)) throw new Error("That person is not on this business");
  return setConsent(consentFile(), personId, consent, presenceNow());
}

export function consentView(): Array<{ personId: string; consent: boolean; consentedAt: number; revokedAt: number | null }> {
  const people = readConsent(consentFile());
  return Object.entries(people).map(([personId, row]) => ({
    personId,
    consent: consentActive(people, personId),
    consentedAt: row.consentedAt,
    revokedAt: row.revokedAt,
  }));
}

export function issuePersonDevice(personId: string, label: string): { id: string; personId: string; label: string; token: string; createdAt: number } {
  if (!roster().some((person) => person.id === personId)) throw new Error("That person is not on this business");
  const { device, token } = issueDevice(deviceFile(), { personId, label: label.trim().slice(0, 80), now: presenceNow() });
  return { id: device.id, personId: device.personId, label: device.label, token, createdAt: device.createdAt };
}

export function listPersonDevices() {
  return readDevices(deviceFile()).map(publicDevice);
}

export function revokePersonDevice(id: string) {
  const row = revokeDevice(deviceFile(), id, presenceNow());
  if (!row) throw new Error("That device isn't here");
  return publicDevice(row);
}

export function reviewPersonDevice(id: string) {
  const row = writeDeviceSession(deviceFile(), id, blankSession());
  if (!row) throw new Error("That device isn't here");
  return publicDevice(row);
}

export function personForPresentedDevice(token: string, ip: string): { personId: string; deviceId: string } | null {
  if (deviceAuthLocked(ip)) throw new HttpError(429, "Too many tries");
  const row = findLiveDevice(readDevices(deviceFile()), token);
  if (!row) {
    if (noteDeviceFailure(ip)) throw new HttpError(429, "Too many tries");
    return null;
  }
  clearDeviceFailures(ip);
  return { personId: row.personId, deviceId: row.id };
}

export function enrolledDevice(id: string): DeviceRow | null {
  return readDevices(deviceFile()).find((row) => row.id === id && row.revokedAt == null) ?? null;
}

export function saveDeviceSession(id: string, session: SessionState): DeviceRow | null {
  return writeDeviceSession(deviceFile(), id, session);
}

function radioFile(kind: "wifi" | "ble"): string {
  return kind === "wifi" ? wifiFile() : beaconFile();
}

export function saveRadio(
  kind: "wifi" | "ble",
  input: { deviceId: string; personId: string; label: string; kind: RadioKind },
): ReturnType<typeof publicRadio> {
  if (!roster().some((person) => person.id === input.personId)) throw new Error("That person is not on this business");
  const row = upsertRadio(radioFile(kind), { ...input, now: presenceNow(), pepper: deviceHashPepper() });
  return publicRadio(row);
}

export function listRadios(kind: "wifi" | "ble") {
  return readRadios(radioFile(kind)).map(publicRadio);
}

export function revokeRadioId(kind: "wifi" | "ble", id: string) {
  const row = revokeRadio(radioFile(kind), id, presenceNow());
  if (!row) throw new Error("That device isn't here");
  return publicRadio(row);
}

export function reviewRadio(kind: "wifi" | "ble", id: string) {
  const row = writeRadioSession(radioFile(kind), id, blankSession());
  if (!row) throw new Error("That device isn't here");
  return publicRadio(row);
}

export function liveRadio(kind: "wifi" | "ble", presentedId: string): RadioRow | null {
  return findLiveRadio(readRadios(radioFile(kind)), presentedId, deviceHashPepper());
}

export function saveRadioSession(kind: "wifi" | "ble", id: string, session: SessionState): RadioRow | null {
  return writeRadioSession(radioFile(kind), id, session);
}

type WatchFile = { version: 1; people: Record<string, WatchPerson> };

function readWatchFile(): WatchFile {
  const file = watchFile();
  if (!existsSync(file)) return { version: 1, people: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as WatchFile;
    if (!parsed.people || typeof parsed.people !== "object") return { version: 1, people: {} };
    return { version: 1, people: parsed.people };
  } catch {
    return { version: 1, people: {} };
  }
}

export function watchFor(personId: string): WatchPerson | null {
  return readWatchFile().people[personId] ?? null;
}

export function saveWatch(personId: string, person: WatchPerson) {
  const file = readWatchFile();
  file.people[personId] = person;
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(watchFile(), JSON.stringify(file));
}

export function recallReplay(key: string) {
  return recallSignal(replayFile(), key);
}

export function rememberReplay(key: string, status: number, body: unknown) {
  const signal = signalConfigFromEnv();
  rememberSignal(replayFile(), key, status, body, Date.now(), Math.max(signal.maxAgeMs * 4, 10 * 60_000));
}

export function signalAllowed(ip: string): boolean {
  return allowSignal(`signal:${ip}`, signalConfigFromEnv().ratePerMin);
}

export function personDay(personId: string) {
  return ensureBook().day(personId, presenceNow());
}

export async function commitNote(input: {
  person: { id: string; name: string };
  type: PunchType;
  ts: number;
  source: string;
  closesDay?: boolean;
  flag?: string | null;
  fix?: { lat: number; lng: number; accuracy: number; capturedAt: number } | null;
  distanceM?: number;
}): Promise<{ record: PunchRecord | null; effect: PunchEffect }> {
  const current = ensureBook();
  const result = await current.note(input);
  if (result.record) {
    rememberPlan(await current.mirror([input.person.id], presenceNow()));
    applyAll();
    if (result.effect !== "none") {
      publish({ kind: result.effect, personId: result.record.personId, ts: result.record.ts });
    }
  }
  return { record: result.record, effect: result.effect };
}

export async function takePunch(input: PunchInput): Promise<{
  record: PunchRecord;
  effect: PunchEffect;
  view: PresenceView;
}> {
  if (!personHasConsent(input.person.id)) {
    throw new HttpError(403, "Presence needs a yes from that person");
  }
  const current = ensureBook();
  const result = await current.punch(input);
  rememberPlan(await current.mirror([input.person.id], presenceNow()));
  applyAll();
  if (result.effect !== "none") {
    publish({ kind: result.effect, personId: result.record.personId, ts: result.record.ts });
  }
  return { ...result, view: presenceView(input.person.id) };
}

export function askCorrection(person: { id: string; name: string }, leaveTs: number): Correction {
  return ensureBook().requestCorrection(person, leaveTs, presenceNow());
}

export async function resolveCorrection(id: string, status: "approved" | "denied"): Promise<Correction> {
  const current = ensureBook();
  const row = await current.decideCorrection(id, status, presenceNow());
  if (status === "approved") {
    rememberPlan(await current.mirror([row.personId], presenceNow()));
    applyAll();
    publish({ kind: "close", personId: row.personId, ts: row.leaveTs });
  }
  return row;
}

export function subscribe(res: Response) {
  listeners.add(res);
  res.on("close", () => listeners.delete(res));
}

export function publish(event: { kind: string; personId: string; ts: number }) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of Array.from(listeners)) res.write(line);
}

export function personById(id: string): RosterPerson | null {
  return roster().find((person) => person.id === id) ?? null;
}

export function localDate(ts = presenceNow()): string {
  return zonedParts(ts, SHOP_PRESENCE.tz).key;
}

export { presenceReasonText };
