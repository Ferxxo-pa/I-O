import { z } from "zod";
import { RELAY_TTL_MS } from "@shared/relayBox";
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
  flagPersonDevice,
} from "./service";
import { shopTeamId } from "./shop";
import { SquareMemberError } from "../square/labor";
import { deviceLatched, dropPhoneLatches, noteSight, type WatchPerson } from "./watch";

const phoneSchema = z
  .object({
    event: z.enum(["arrive", "leave"]),
    trigger: z.enum(["geo", "wifi"]),
    ts: z.number().optional(),
    eventId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
  })
  .strict();

type PhoneSignal = z.infer<typeof phoneSchema>;

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

export function phoneSetupSnippet(input: { url: string; token: string; name: string; relayUrl?: string }): string {
  const header = `Authorization: Bearer ${input.token}`;
  if (!input.relayUrl) {
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
  const body = (event: "arrive" | "leave", trigger: "geo" | "wifi") =>
    `{"event":"${event}","trigger":"${trigger}","ts":EVENT_ID,"eventId":"EVENT_ID"}`;
  const posts = (event: "arrive" | "leave", trigger: "geo" | "wifi") =>
    [`POST ${input.url}`, header, body(event, trigger)].join("\n");
  return [
    `Shop presence for ${input.name}`,
    "",
    "Capture the current time in milliseconds once. Use that same number as ts and eventId on every post of that firing.",
    "These posts go to the shop computer on Premiere.",
    "Shortcuts and MacroDroid cannot seal a cellular leave. Do not POST the event JSON to the mailbox.",
    `Mailbox POST ${input.relayUrl}`,
    'A client that can seal sends only {"box":"...","sig":"..."} . The mailbox never sees the shop key.',
    "",
    "Header",
    header,
    "",
    "Arrive at the shop (location)",
    posts("arrive", "geo"),
    "",
    "Leave the shop (location)",
    posts("leave", "geo"),
    "",
    "Joined the shop Wi-Fi",
    posts("arrive", "wifi"),
    "",
    "Left the shop Wi-Fi",
    posts("leave", "wifi"),
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

function clockTarget(
  person: { id: string; name: string; hourlyCents: number; squareTeamMemberId: string | null },
  device: { personId: string; squareTeamMemberId: string },
): { id: string; name: string; hourlyCents: number } | null {
  if (device.personId !== person.id) return null;
  const squareId = person.squareTeamMemberId ?? "";
  if (device.squareTeamMemberId !== squareId) return null;
  return { id: squareId || person.id, name: person.name, hourlyCents: person.hourlyCents };
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
  const token = bearerToken(input.authorization);
  if (!token) return { status: 401, body: { message: "Unknown device" } };
  if (mentionsWage(input.rawBody)) return { status: 400, body: { message: "Presence never writes a wage" } };
  if (!signalAllowed(input.ip)) return { status: 429, body: { message: "Too many signals" } };
  const parsed = phoneSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { message: "Check the signal" } };
  const signal = parsed.data;
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

  return applyPhoneSignal({
    deviceId,
    personId,
    signal,
    maxAgeMs: signalConfigFromEnv().phoneMaxAgeMs,
  });
}

/** Same clock path as a phone post. The relay poller passes a 72 hour window. */
export async function applyPhoneSignal(input: {
  deviceId: string;
  personId: string;
  signal: PhoneSignal;
  maxAgeMs: number;
}): Promise<{ status: number; body: PhoneResponse }> {
  const { deviceId, personId, signal } = input;
  const now = presenceNow();
  const at = signal.ts ?? now;
  const config = signalConfigFromEnv();
  const timing = signal.ts == null ? "ok" : at - now > config.maxFutureMs ? "future_signal" : now - at > input.maxAgeMs ? "stale_signal" : "ok";
  const bucket = Math.floor(at / config.phoneDedupeMs);
  const bucketKey = `phone:${deviceId}:${signal.trigger}:${signal.event}:${bucket}`;
  const eventKey = signal.eventId ? `phone:${deviceId}:evt:${signal.eventId}:${at}` : null;
  const eidKey = signal.eventId ? `phone:${deviceId}:eid:${signal.eventId}` : null;
  const replayKey = eventKey ?? bucketKey;
  if (eidKey) {
    const seen = recallReplay(eidKey);
    if (seen && seen.body && typeof seen.body === "object") {
      return { status: seen.status, body: { ...(seen.body as PhoneResponse), duplicate: true } };
    }
  }
  const prior = recallReplay(replayKey);
  if (prior && prior.body && typeof prior.body === "object") {
    return { status: prior.status, body: { ...(prior.body as PhoneResponse), duplicate: true } };
  }
  const finish = (status: number, body: PhoneResponse) => {
    rememberReplay(replayKey, status, body, eventKey ? RELAY_TTL_MS : undefined);
    if (eidKey && timing === "ok") rememberReplay(eidKey, status, body, RELAY_TTL_MS);
    return { status, body };
  };

  if (timing === "stale_signal") {
    const body = empty({ ok: true, personId, event: signal.event, trigger: signal.trigger, applied: "rejected", reason: timing });
    rememberReplay(bucketKey, 200, body);
    return { status: 200, body };
  }

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
  if (!device || !person) {
    return { status: 401, body: empty({ personId, applied: "rejected", reason: "unknown_device" }) };
  }
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
    const clockPerson = clockTarget(person, device);
    if (!clockPerson) {
      return finish(200, empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied: "rejected", reason: "square_mismatch" }));
    }
    const source = signal.trigger === "wifi" ? "phone-wifi" : "phone-geo";
    const info = earnEngine.shiftInfo(clockPerson.id);
    if (!(info?.clockedIn)) {
      try {
        await earnEngine.clockInPerson(clockPerson, at, source);
      } catch (err) {
        if (err instanceof SquareMemberError) {
          flagPersonDevice(device.id, err.reason);
          return finish(200, empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied: "rejected", reason: err.reason }));
        }
        throw err;
      }
      if (device.squareFlag) flagPersonDevice(device.id, null);
    } else if (info.managedBy !== "presence" && info.holdAt != null) {
      try {
        await earnEngine.clockInPerson(clockPerson, at, source);
      } catch (err) {
        if (err instanceof SquareMemberError) {
          flagPersonDevice(device.id, err.reason);
          return finish(200, empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied: "rejected", reason: err.reason }));
        }
        throw err;
      }
    }
    saveDeviceSession(device.id, { sessionStart, lastSeenAt: at, stationaryAt: null });
    saveWatch(person.id, noteSight(watch, { source: "phone", sourceId, at, present: true, latch: true }));
    recordPhoneEvent({ personId: person.id, teamId: shopTeamId(), deviceId: device.id, event: "arrive", trigger: signal.trigger, at, receivedAt: now });
    const applied = info?.clockedIn && info.holdAt == null ? "seen" : "arrive";
    return finish(200, empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied }));
  }

  const marked = noteSight(watch, { source: "phone", sourceId, at, present: false, latch: true });
  // A location leave means they left the shop. It also clears a Wi-Fi latch, so an
  // iPhone that can join Wi-Fi but cannot send "left the network" still clocks out.
  const next = signal.trigger === "geo" ? dropPhoneLatches(marked, device.id, at) : marked;
  saveWatch(person.id, next);
  recordPhoneEvent({ personId: person.id, teamId: shopTeamId(), deviceId: device.id, event: "leave", trigger: signal.trigger, at, receivedAt: now });
  if (!deviceLatched(watchFor(person.id), device.id, now, config.quietMs)) {
    saveDeviceSession(device.id, { sessionStart: null, lastSeenAt: at, stationaryAt: null });
    const clockPerson = clockTarget(person, device);
    const info = clockPerson ? earnEngine.shiftInfo(clockPerson.id) : null;
    if (clockPerson && info?.clockedIn && info.managedBy !== "presence") earnEngine.holdWork(clockPerson.id, at);
  }
  return finish(200, empty({ ok: true, personId: person.id, event: "leave", trigger: signal.trigger, applied: "exit" }));
}

/** Confirms the token and consent. Does not clock in or out. */
export function pingPhone(input: {
  authorization: string | undefined;
  ip: string;
}): { status: number; body: { ok: boolean; connected: boolean; name?: string; message?: string } } {
  const token = bearerToken(input.authorization);
  if (!token) return { status: 401, body: { ok: false, connected: false, message: "Unknown device" } };
  try {
    const found = personForPresentedDevice(token, input.ip);
    if (!found) return { status: 401, body: { ok: false, connected: false, message: "Unknown device" } };
    const person = personById(found.personId);
    if (!person) return { status: 401, body: { ok: false, connected: false, message: "Unknown device" } };
    if (!personHasConsent(person.id)) {
      return { status: 403, body: { ok: false, connected: false, name: person.name, message: "No consent" } };
    }
    return { status: 200, body: { ok: true, connected: true, name: person.name } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Too many tries";
    return { status: 429, body: { ok: false, connected: false, message } };
  }
}
