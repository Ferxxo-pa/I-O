import { z } from "zod";
import type { DayPhase } from "@shared/presence";
import { bleHmacSecret, dayConfigFromEnv, signalConfigFromEnv, wifiHmacSecret } from "./config";
import { fenceFromEnv, judgeFix } from "./geo";
import { hmacMatches } from "./sign";
import { advanceSession, sawOvernight, withinCollection } from "./session";
import {
  commitNote,
  enrolledDevice,
  liveRadio,
  personById,
  personDay,
  personForPresentedDevice,
  personHasConsent,
  presenceNow,
  recallReplay,
  rememberReplay,
  saveDeviceSession,
  saveRadioSession,
  saveWatch,
  signalAllowed,
  takePunch,
  watchFor,
} from "./service";
import { normalizeEvent, noteSight, signalTimeDecision, type SignalEvent } from "./watch";

const HOST_KEYS = ["hostname", "hostName", "host", "name", "clientName", "dhcpName", "dnsName", "ssid"];

const signalSchema = z
  .object({
    source: z.enum(["geofence", "wifi", "ble"]),
    sourceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
    event: z.string().min(1).max(32),
    ts: z.number(),
    id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    personId: z.string().min(1).max(80).optional(),
    deviceId: z.string().min(1).max(128).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    accuracy: z.number().optional(),
  })
  .strict();

type SignalBody = z.infer<typeof signalSchema>;

export type SignalResponse = {
  ok: boolean;
  duplicate: boolean;
  source: string | null;
  event: string | null;
  personId: string | null;
  applied: "arrive" | "seen" | "exit" | "ignored" | "rejected";
  reason: string | null;
  stub: boolean;
  punch: {
    accepted: boolean;
    type: string;
    ts: number;
    source: string;
    reason: string | null;
    flag: string | null;
    effect: string;
  } | null;
};

function mentionsWage(raw: string): boolean {
  return /"(hourly_rate|hourlyCents|hourly|wage|amount)"\s*:/.test(raw);
}

function stripHost(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const key of HOST_KEYS) delete copy[key];
  return copy;
}

function emptyResponse(partial: Partial<SignalResponse> = {}): SignalResponse {
  return {
    ok: false,
    duplicate: false,
    source: null,
    event: null,
    personId: null,
    applied: "rejected",
    reason: null,
    stub: false,
    punch: null,
    ...partial,
  };
}

function finish(
  status: number,
  body: SignalResponse,
  replayKey: string | null,
): { status: number; body: SignalResponse } {
  if (replayKey) rememberReplay(replayKey, status, body);
  return { status, body };
}

function opensDay(phase: DayPhase): boolean {
  return phase === "out" || phase === "break" || phase === "pending";
}

export async function ingestSignal(input: {
  rawBody: string;
  body: unknown;
  deviceToken: string | null;
  signature: string | null;
  ip: string;
}): Promise<{ status: number; body: SignalResponse | { message: string } }> {
  if (mentionsWage(input.rawBody)) {
    return { status: 400, body: { message: "Presence never writes a wage" } };
  }
  const parsed = signalSchema.safeParse(stripHost(input.body));
  if (!parsed.success) return { status: 400, body: { message: "Check the signal" } };
  const signal = parsed.data;
  const event = normalizeEvent(signal.event);
  if (!event) return { status: 400, body: { message: "Check the signal" } };
  if (!signalAllowed(input.ip)) return { status: 429, body: { message: "Too many signals" } };

  const authed = authenticate(signal, input.deviceToken, input.signature, input.rawBody, input.ip);
  if (authed.status) return { status: authed.status, body: { message: authed.message ?? "Bad signature" } };

  const now = presenceNow();
  const replayKey = `${signal.source}:${signal.id}`;
  const prior = recallReplay(replayKey);
  if (prior && prior.body && typeof prior.body === "object") {
    return { status: prior.status, body: { ...(prior.body as SignalResponse), duplicate: true } };
  }

  const timing = signalTimeDecision(signal.ts, now, signalConfigFromEnv().maxAgeMs, signalConfigFromEnv().maxFutureMs);
  if (timing !== "ok") {
    return finish(
      200,
      emptyResponse({
        ok: true,
        source: signal.source,
        event,
        applied: "rejected",
        reason: timing,
      }),
      replayKey,
    );
  }

  const day = dayConfigFromEnv();
  const signalConfig = signalConfigFromEnv();
  if (!withinCollection(signal.ts, day, signalConfig.collectMarginMs)) {
    return finish(
      200,
      emptyResponse({
        ok: true,
        source: signal.source,
        event,
        applied: "ignored",
        reason: "outside_hours",
      }),
      replayKey,
    );
  }

  if (signal.source === "ble" && !signalConfig.bleEnabled) {
    return finish(
      200,
      emptyResponse({
        ok: true,
        source: "ble",
        event,
        applied: "ignored",
        reason: "ble_stub",
        stub: true,
      }),
      replayKey,
    );
  }

  if (signal.source === "geofence") {
    return finishGeofence(signal, event, authed.deviceId, replayKey, now);
  }
  return finishRadio(signal, event, signal.source, replayKey);
}

function authenticate(
  signal: SignalBody,
  deviceToken: string | null,
  signature: string | null,
  rawBody: string,
  ip: string,
): { status?: number; message?: string; deviceId?: string; personId?: string } {
  if (signal.source === "geofence") {
    if (!deviceToken) return { status: 401, message: "Unknown device" };
    try {
      const found = personForPresentedDevice(deviceToken, ip);
      if (!found) return { status: 401, message: "Unknown device" };
      return { deviceId: found.deviceId, personId: found.personId };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Too many tries";
      return { status: 429, message };
    }
  }
  const secret = signal.source === "wifi" ? wifiHmacSecret() : bleHmacSecret();
  if (!hmacMatches(secret, rawBody, signature)) return { status: 401, message: "Bad signature" };
  return {};
}

async function finishGeofence(
  signal: SignalBody,
  event: SignalEvent,
  deviceId: string | undefined,
  replayKey: string,
  now: number,
): Promise<{ status: number; body: SignalResponse }> {
  const device = deviceId ? enrolledDevice(deviceId) : null;
  if (!device) {
    return finish(401, emptyResponse({ reason: "unknown_device" }), null);
  }
  const person = personById(device.personId);
  if (!person) return finish(403, emptyResponse({ reason: "unknown_person" }), replayKey);
  if (signal.personId && signal.personId !== person.id) {
    if (!personHasConsent(person.id)) return noConsent(signal.source, event, replayKey);
    const result = await takePunch({
      person,
      claimedPersonId: signal.personId,
      type: "arrive",
      fix: fixOf(signal),
      source: "geofence",
      desk: false,
    });
    return finish(
      403,
      emptyResponse({
        ok: false,
        source: "geofence",
        event,
        personId: person.id,
        applied: "rejected",
        reason: "wrong_person",
        punch: punchOf(result.record, result.effect),
      }),
      replayKey,
    );
  }
  if (!personHasConsent(person.id)) return noConsent("geofence", event, replayKey);

  if (event === "exit") {
    if (device.stationaryAt == null) {
      saveWatch(person.id, noteSight(watchFor(person.id), { source: "geofence", sourceId: signal.sourceId, at: signal.ts, present: false }));
    }
    return finish(
      200,
      emptyResponse({
        ok: true,
        source: "geofence",
        event,
        personId: person.id,
        applied: device.stationaryAt == null ? "exit" : "ignored",
        reason: device.stationaryAt == null ? null : "stationary",
      }),
      replayKey,
    );
  }

  const fix = fixOf(signal);
  const fence = fenceFromEnv();
  const judged = judgeFix(fix, fence, now);
  if (!judged.accepted) {
    const result = await takePunch({
      person,
      claimedPersonId: signal.personId ?? null,
      type: "arrive",
      fix,
      source: "geofence",
      desk: false,
    });
    return finish(
      200,
      emptyResponse({
        ok: true,
        source: "geofence",
        event,
        personId: person.id,
        applied: "rejected",
        reason: result.record.reason,
        punch: punchOf(result.record, result.effect),
      }),
      replayKey,
    );
  }

  const session = nextSession(device, signal.ts);
  saveDeviceSession(device.id, session.session);
  if (!session.drives) {
    return finish(
      200,
      emptyResponse({
        ok: true,
        source: "geofence",
        event,
        personId: person.id,
        applied: "ignored",
        reason: "stationary",
      }),
      replayKey,
    );
  }

  const phase = personDay(person.id).phase;
  saveWatch(person.id, noteSight(watchFor(person.id), { source: "geofence", sourceId: signal.sourceId, at: signal.ts, present: true }));
  if (phase === "closed" || !opensDay(phase)) {
    return finish(
      200,
      emptyResponse({
        ok: true,
        source: "geofence",
        event,
        personId: person.id,
        applied: phase === "closed" ? "ignored" : "seen",
        reason: phase === "closed" ? "day_closed" : null,
      }),
      replayKey,
    );
  }
  const result = await takePunch({
    person,
    claimedPersonId: null,
    type: "arrive",
    fix,
    source: "geofence",
    desk: false,
  });
  return finish(
    200,
    emptyResponse({
      ok: true,
      source: "geofence",
      event,
      personId: person.id,
      applied: result.record.accepted ? "arrive" : "rejected",
      reason: result.record.reason,
      punch: punchOf(result.record, result.effect),
    }),
    replayKey,
  );
}

async function finishRadio(
  signal: SignalBody,
  event: SignalEvent,
  source: "wifi" | "ble",
  replayKey: string,
): Promise<{ status: number; body: SignalResponse }> {
  if (!signal.deviceId) return { status: 400, body: emptyResponse({ source, event, reason: "missing_device" }) };
  const row = liveRadio(source, signal.deviceId);
  if (!row) {
    return finish(
      200,
      emptyResponse({ ok: true, source, event, applied: "ignored", reason: "unenrolled" }),
      replayKey,
    );
  }
  if (row.kind !== "phone") {
    return finish(
      200,
      emptyResponse({ ok: true, source, event, personId: row.personId, applied: "ignored", reason: "not_phone" }),
      replayKey,
    );
  }
  const person = personById(row.personId);
  if (!person) {
    return finish(200, emptyResponse({ ok: true, source, event, applied: "ignored", reason: "unknown_person" }), replayKey);
  }
  if (signal.personId && signal.personId !== person.id) {
    return finish(
      403,
      emptyResponse({ source, event, personId: person.id, applied: "rejected", reason: "wrong_person" }),
      replayKey,
    );
  }
  if (!personHasConsent(person.id)) return noConsent(source, event, replayKey);

  if (event === "exit") {
    if (row.stationaryAt == null) {
      saveWatch(person.id, noteSight(watchFor(person.id), { source, sourceId: signal.sourceId, at: signal.ts, present: false }));
    }
    return finish(
      200,
      emptyResponse({
        ok: true,
        source,
        event,
        personId: person.id,
        applied: row.stationaryAt == null ? "exit" : "ignored",
        reason: row.stationaryAt == null ? null : "stationary",
      }),
      replayKey,
    );
  }

  const session = nextSession(row, signal.ts);
  saveRadioSession(source, row.id, session.session);
  if (!session.drives) {
    return finish(
      200,
      emptyResponse({
        ok: true,
        source,
        event,
        personId: person.id,
        applied: "ignored",
        reason: "stationary",
      }),
      replayKey,
    );
  }

  const phase = personDay(person.id).phase;
  saveWatch(person.id, noteSight(watchFor(person.id), { source, sourceId: signal.sourceId, at: signal.ts, present: true }));
  if (!opensDay(phase)) {
    return finish(
      200,
      emptyResponse({
        ok: true,
        source,
        event,
        personId: person.id,
        applied: phase === "closed" ? "ignored" : "seen",
        reason: phase === "closed" ? "day_closed" : null,
      }),
      replayKey,
    );
  }
  const noted = await commitNote({
    person,
    type: "arrive",
    ts: presenceNow(),
    source,
  });
  return finish(
    200,
    emptyResponse({
      ok: true,
      source,
      event,
      personId: person.id,
      applied: noted.record?.accepted ? "arrive" : "rejected",
      reason: noted.record?.reason ?? null,
      punch: noted.record ? punchOf(noted.record, noted.effect) : null,
    }),
    replayKey,
  );
}

function nextSession(
  row: { sessionStart: number | null; lastSeenAt: number | null; stationaryAt: number | null },
  at: number,
) {
  const day = dayConfigFromEnv();
  const signal = signalConfigFromEnv();
  const overnight = sawOvernight({
    prevSeen: row.lastSeenAt,
    at,
    day,
    marginMs: signal.collectMarginMs,
    edgeMs: signal.overnightEdgeMs,
    continuousGapMs: signal.quietMs,
  });
  return advanceSession({
    session: {
      sessionStart: row.sessionStart,
      lastSeenAt: row.lastSeenAt,
      stationaryAt: row.stationaryAt,
    },
    at,
    stationaryMs: signal.stationaryMs,
    gapResetMs: signal.quietMs,
    overnight,
  });
}

function noConsent(source: string, event: SignalEvent, replayKey: string) {
  return finish(
    403,
    emptyResponse({
      source,
      event,
      applied: "rejected",
      reason: "no_consent",
    }),
    replayKey,
  );
}

function fixOf(signal: SignalBody): { lat: number; lng: number; accuracy: number; capturedAt: number } | null {
  if (signal.lat == null || signal.lng == null || signal.accuracy == null) return null;
  return { lat: signal.lat, lng: signal.lng, accuracy: signal.accuracy, capturedAt: signal.ts };
}

function punchOf(
  record: { accepted: boolean; type: string; ts: number; source: string; reason: string | null; flag: string | null },
  effect: string,
): SignalResponse["punch"] {
  return {
    accepted: record.accepted,
    type: record.type,
    ts: record.ts,
    source: record.source,
    reason: record.reason,
    flag: record.flag,
    effect,
  };
}
