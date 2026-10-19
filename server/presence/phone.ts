import { z } from "zod";
import { earnEngine } from "../clock/engine";
import { dayConfigFromEnv, signalConfigFromEnv } from "./config";
import { withinCollection } from "./session";
import {
  enrolledDevice,
  personById,
  personForPresentedDevice,
  personHasConsent,
  presenceNow,
  recallReplay,
  recordPhoneEvent,
  rememberReplay,
  saveDeviceSession,
  saveWatch,
  signalAllowed,
  watchFor,
} from "./service";
import { shopTeamId } from "./shop";
import { deviceLatched, dropPhoneLatches, noteSight, type WatchPerson } from "./watch";

const phoneSchema = z
  .object({
    event: z.enum(["arrive", "leave"]),
    trigger: z.enum(["geo", "wifi"]),
    ts: z.number().optional(),
  })
  .strict();

export type PhoneResponse = {
  ok: boolean;
  duplicate: boolean;
  personId: string | null;
  event: "arrive" | "leave" | null;
  trigger: "geo" | "wifi" | null;
  applied: "arrive" | "seen" | "exit" | "ignored" | "rejected";
  reason: string | null;
};

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function latestPhoneAt(watch: WatchPerson | null, deviceId: string): number {
  if (!watch) return 0;
  const prefix = `phone:${deviceId}:`;
  let latest = 0;
  for (const [key, source] of Object.entries(watch.sources)) {
    if (key.startsWith(prefix) && source.at > latest) latest = source.at;
  }
  return latest;
}

export function presencePublicBase(input: { configured: string | undefined; proto: string; host: string }): string {
  const set = input.configured?.trim().replace(/\/$/, "") ?? "";
  if (set) return set;
  return `${input.proto}://${input.host}`;
}

export function phoneSetupSnippet(input: { url: string; token: string; name: string }): string {
  const header = `Authorization: Bearer ${input.token}`;
  return [
    `Shop presence for ${input.name}`,
    "",
    "URL",
    input.url,
    "",
    "Header",
    header,
    "",
    "Arrive at the shop (location)",
    '{"event":"arrive","trigger":"geo"}',
    "",
    "Leave the shop (location)",
    '{"event":"leave","trigger":"geo"}',
    "",
    "Joined the shop Wi-Fi",
    '{"event":"arrive","trigger":"wifi"}',
    "",
    "Left the shop Wi-Fi",
    '{"event":"leave","trigger":"wifi"}',
    "",
    "Method is POST. Send the header on every request. The token is shown once.",
  ].join("\n");
}

function empty(partial: Partial<PhoneResponse> = {}): PhoneResponse {
  return {
    ok: false,
    duplicate: false,
    personId: null,
    event: null,
    trigger: null,
    applied: "rejected",
    reason: null,
    ...partial,
  };
}

function mentionsWage(raw: string): boolean {
  return /"(hourly_rate|hourlyCents|hourly|wage|amount)"\s*:/.test(raw);
}

export async function ingestPhone(input: {
  rawBody: string;
  body: unknown;
  authorization: string | undefined;
  ip: string;
}): Promise<{ status: number; body: PhoneResponse | { message: string } }> {
  if (mentionsWage(input.rawBody)) return { status: 400, body: { message: "Presence never writes a wage" } };
  const parsed = phoneSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { message: "Check the signal" } };
  const signal = parsed.data;
  if (!signalAllowed(input.ip)) return { status: 429, body: { message: "Too many signals" } };

  const token = bearerToken(input.authorization);
  if (!token) return { status: 401, body: { message: "Unknown device" } };
  let deviceId = "";
  let personId = "";
  try {
    const found = personForPresentedDevice(token, input.ip);
    if (!found) return { status: 401, body: { message: "Unknown device" } };
    deviceId = found.deviceId;
    personId = found.personId;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Too many tries";
    return { status: 429, body: { message } };
  }

  const now = presenceNow();
  const at = signal.ts ?? now;
  const config = signalConfigFromEnv();
  const timing = signal.ts == null ? "ok" : at - now > config.maxFutureMs ? "future_signal" : now - at > config.phoneMaxAgeMs ? "stale_signal" : "ok";
  const bucket = Math.floor(at / config.phoneDedupeMs);
  const replayKey = `phone:${deviceId}:${signal.trigger}:${signal.event}:${bucket}`;
  const prior = recallReplay(replayKey);
  if (prior && prior.body && typeof prior.body === "object") {
    return { status: prior.status, body: { ...(prior.body as PhoneResponse), duplicate: true } };
  }
  const finish = (status: number, body: PhoneResponse) => {
    rememberReplay(replayKey, status, body);
    return { status, body };
  };

  if (timing !== "ok") {
    return finish(200, empty({ ok: true, personId, event: signal.event, trigger: signal.trigger, applied: "rejected", reason: timing }));
  }
  if (!withinCollection(at, dayConfigFromEnv(), config.collectMarginMs)) {
    return finish(
      200,
      empty({ ok: true, personId, event: signal.event, trigger: signal.trigger, applied: "ignored", reason: "outside_hours" }),
    );
  }

  const device = enrolledDevice(deviceId);
  const person = personById(personId);
  if (!device || !person) return { status: 401, body: { message: "Unknown device" } };
  if (!personHasConsent(person.id)) {
    return finish(403, empty({ personId: person.id, event: signal.event, trigger: signal.trigger, applied: "rejected", reason: "no_consent" }));
  }
  if (device.stationaryAt != null) {
    return finish(
      200,
      empty({ ok: true, personId: person.id, event: signal.event, trigger: signal.trigger, applied: "ignored", reason: "stationary" }),
    );
  }

  const sourceId = `${device.id}:${signal.trigger}`;
  const watch = watchFor(person.id);
  const latest = latestPhoneAt(watch, device.id);
  if (at < latest) {
    recordPhoneEvent({
      personId: person.id,
      teamId: shopTeamId(),
      deviceId: device.id,
      event: signal.event,
      trigger: signal.trigger,
      at,
      receivedAt: now,
    });
    return finish(
      200,
      empty({ ok: true, personId: person.id, event: signal.event, trigger: signal.trigger, applied: "ignored", reason: "out_of_order" }),
    );
  }
  if (signal.event === "arrive") {
    const still = deviceLatched(watch, device.id, now, config.quietMs);
    const sessionStart = still && device.sessionStart != null ? device.sessionStart : at;
    if (at - sessionStart >= config.stationaryMs) {
    saveDeviceSession(device.id, { sessionStart, lastSeenAt: at, stationaryAt: at });
    saveWatch(person.id, noteSight(watch, { source: "phone", sourceId, at, present: false, latch: true }));
    recordPhoneEvent({ personId: person.id, teamId: shopTeamId(), deviceId: device.id, event: "arrive", trigger: signal.trigger, at, receivedAt: now });
      return finish(
        200,
        empty({ ok: true, personId: person.id, event: signal.event, trigger: signal.trigger, applied: "ignored", reason: "stationary" }),
      );
    }
    saveDeviceSession(device.id, { sessionStart, lastSeenAt: at, stationaryAt: null });
    saveWatch(person.id, noteSight(watch, { source: "phone", sourceId, at, present: true, latch: true }));
    recordPhoneEvent({ personId: person.id, teamId: shopTeamId(), deviceId: device.id, event: "arrive", trigger: signal.trigger, at, receivedAt: now });
    const clockPerson = { id: person.id, name: person.name, hourlyCents: person.hourlyCents };
    const source = signal.trigger === "wifi" ? "phone-wifi" : "phone-geo";
    const info = earnEngine.shiftInfo(person.id);
    if (info?.clockedIn) {
      if (info.managedBy !== "presence" && info.holdAt != null) {
        await earnEngine.clockInPerson(clockPerson, at, source);
        return finish(200, empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied: "arrive" }));
      }
      return finish(200, empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied: "seen" }));
    }
    await earnEngine.clockInPerson(clockPerson, at, source);
    return finish(200, empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied: "arrive" }));
  }

  const marked = noteSight(watch, { source: "phone", sourceId, at, present: false, latch: true });
  // A location leave means they left the shop. It also clears a Wi-Fi latch, so an
  // iPhone that can join Wi-Fi but cannot send "left the network" still clocks out.
  const next = signal.trigger === "geo" ? dropPhoneLatches(marked, device.id, at) : marked;
  saveWatch(person.id, next);
  recordPhoneEvent({ personId: person.id, teamId: shopTeamId(), deviceId: device.id, event: "leave", trigger: signal.trigger, at, receivedAt: now });
  if (!deviceLatched(watchFor(person.id), device.id, now, config.quietMs)) {
    saveDeviceSession(device.id, { sessionStart: null, lastSeenAt: at, stationaryAt: null });
    const info = earnEngine.shiftInfo(person.id);
    if (info?.clockedIn && info.managedBy !== "presence") earnEngine.holdWork(person.id, at);
  }
  return finish(200, empty({ ok: true, personId: person.id, event: "leave", trigger: signal.trigger, applied: "exit" }));
}
