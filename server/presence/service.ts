import { timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import { zonedParts } from "@shared/fight";
import { SHOP_PRESENCE, presenceReasonText, type PresenceView, type PunchRecord } from "@shared/presence";
import { earnEngine } from "../clock/engine";
import { getCompany } from "../company";
import type { ClockSignal, Correction, PunchEffect, PunchInput } from "./book";
import { PresenceBook } from "./book";
import { dayConfigFromEnv } from "./config";
import { fenceFromEnv, shopLabel } from "./geo";
import { appendPunchLog, readPunchLog } from "./log";
import { readPinFile, writePinHash } from "./pins";
import { liveTransport, mirrorMode, type MirrorLink, type MirrorTransport, type PlannedCall, type SquarePerson } from "./square";

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

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
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

export async function takePunch(input: PunchInput): Promise<{
  record: PunchRecord;
  effect: PunchEffect;
  view: PresenceView;
}> {
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
