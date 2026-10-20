import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { deviceLatched, noteSight, type WatchPerson } from "./watch";

export type PhoneEvent = {
  personId: string;
  teamId: string;
  deviceId: string;
  event: "arrive" | "leave";
  trigger: "geo" | "wifi" | "nfc";
  at: number;
  receivedAt: number;
};

type DeviceFold = {
  geo: boolean;
  wifi: boolean;
  nfc: boolean;
  streakStart: number | null;
  lastAt: number;
};

export type PhoneFold = {
  watch: WatchPerson | null;
  arrives: number[];
  devices: Map<string, { held: boolean; streakStart: number | null; lastAt: number }>;
};

export function readPhoneEvents(file: string): PhoneEvent[] {
  if (!existsSync(file)) return [];
  const rows: PhoneEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as PhoneEvent;
      if (!row || typeof row.personId !== "string" || typeof row.deviceId !== "string") continue;
      if (row.event !== "arrive" && row.event !== "leave") continue;
      if (row.trigger !== "geo" && row.trigger !== "wifi" && row.trigger !== "nfc") continue;
      if (!Number.isFinite(row.at)) continue;
      rows.push({
        personId: row.personId,
        teamId: typeof row.teamId === "string" ? row.teamId : "",
        deviceId: row.deviceId,
        event: row.event,
        trigger: row.trigger,
        at: row.at,
        receivedAt: Number.isFinite(row.receivedAt) ? row.receivedAt : row.at,
      });
    } catch {
      // Keep the bad line. Replay skips it.
    }
  }
  return rows;
}

export function appendPhoneEvent(file: string, event: PhoneEvent) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`);
}

/**
 * Sort by the phone's timestamp, then by when we received it.
 * A location leave clears both triggers on that phone so one working
 * trigger cannot keep the day open after the person has left.
 */
export function foldPhoneEvents(events: readonly PhoneEvent[]): PhoneFold {
  const sorted = events.slice().sort((a, b) => a.at - b.at || a.receivedAt - b.receivedAt);
  const devices = new Map<string, DeviceFold>();
  const arrives: number[] = [];
  let personOpen = false;
  for (const event of sorted) {
    const device = devices.get(event.deviceId) ?? { geo: false, wifi: false, nfc: false, streakStart: null, lastAt: event.at };
    if (event.event === "arrive") device[event.trigger] = true;
    else if (event.trigger === "geo" || event.trigger === "nfc") {
      device.geo = false;
      device.wifi = false;
      device.nfc = false;
    } else device.wifi = false;
    const on = device.geo || device.wifi || device.nfc;
    if (on && device.streakStart == null) device.streakStart = event.at;
    if (!on) device.streakStart = null;
    device.lastAt = event.at;
    devices.set(event.deviceId, device);
    const any = Array.from(devices.values()).some((row) => row.geo || row.wifi || row.nfc);
    if (any && !personOpen) {
      arrives.push(event.at);
      personOpen = true;
    }
    if (!any) personOpen = false;
  }

  let watch: WatchPerson | null = null;
  const summary = new Map<string, { held: boolean; streakStart: number | null; lastAt: number }>();
  for (const [deviceId, device] of Array.from(devices)) {
    summary.set(deviceId, { held: device.geo || device.wifi || device.nfc, streakStart: device.streakStart, lastAt: device.lastAt });
    for (const trigger of ["geo", "wifi", "nfc"] as const) {
      watch = noteSight(watch, {
        source: "phone",
        sourceId: `${deviceId}:${trigger}`,
        at: device.lastAt,
        present: device[trigger],
        latch: true,
      });
    }
  }
  return { watch, arrives, devices: summary };
}

export function watchHoldsDevice(watch: WatchPerson | null, deviceId: string): boolean {
  return deviceLatched(watch, deviceId, Number.MAX_SAFE_INTEGER, 1);
}
