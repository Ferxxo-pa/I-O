import { z } from "zod";
import {
  bearerToken,
  mentionsWage,
  phoneSetupSnippet,
  planPhone,
  type PhoneResponse,
  type PhoneSignal,
} from "@shared/cloud/phonePlan.ts";

export { bearerToken, phoneSetupSnippet };

import { earnEngine } from "../clock/engine";
import { dayConfigFromEnv, signalConfigFromEnv } from "./config";
import { withinCollection } from "./session";
import {
  enrolledDevice,
  flagPersonDevice,
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
import { SquareMemberError } from "../square/labor";

const phoneSchema = z
  .object({
    event: z.enum(["arrive", "leave"]),
    trigger: z.enum(["geo", "wifi"]),
    ts: z.number().optional(),
    eventId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
  })
  .strict();

export function presencePublicBase(input: { configured: string | undefined; proto: string; host: string }): string {
  const set = input.configured?.trim().replace(/\/$/, "") ?? "";
  if (set) return set;
  return `${input.proto}://${input.host}`;
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
  const bucket = Math.floor(at / config.phoneDedupeMs);
  const eventKey = signal.eventId ? `phone:${deviceId}:evt:${signal.eventId}:${at}` : null;
  const replayKey = eventKey ?? `phone:${deviceId}:${signal.trigger}:${signal.event}:${bucket}`;
  const prior = recallReplay(replayKey);
  if (prior && prior.body && typeof prior.body === "object") {
    return { status: prior.status, body: { ...(prior.body as PhoneResponse), duplicate: true } };
  }

  const device = enrolledDevice(deviceId);
  const person = personById(personId);
  const watch = person ? watchFor(person.id) : null;
  const clockId = person ? (person.squareTeamMemberId || person.id) : personId;
  const info = earnEngine.shiftInfo(clockId);
  const plan = planPhone({
    now,
    signal,
    deviceId,
    personId,
    maxAgeMs: input.maxAgeMs,
    maxFutureMs: config.maxFutureMs,
    dedupeMs: config.phoneDedupeMs,
    inWindow: withinCollection(at, dayConfigFromEnv(), config.collectMarginMs),
    device: device
      ? {
          id: device.id,
          personId: device.personId,
          squareTeamMemberId: device.squareTeamMemberId,
          stationaryAt: device.stationaryAt,
          sessionStart: device.sessionStart,
          squareFlag: device.squareFlag,
        }
      : null,
    person: person
      ? {
          id: person.id,
          name: person.name,
          hourlyCents: person.hourlyCents,
          squareTeamMemberId: person.squareTeamMemberId,
          consent: personHasConsent(person.id),
        }
      : null,
    watch,
    shift: info
      ? { clockedIn: info.clockedIn, holdAt: info.holdAt, managedBy: info.managedBy }
      : null,
    quietMs: config.quietMs,
    stationaryMs: config.stationaryMs,
  });

  if (plan.clockIn) {
    try {
      await earnEngine.clockInPerson(plan.clockIn.person, plan.clockIn.at, plan.clockIn.source);
      if (plan.clockIn.clearFlag && device) flagPersonDevice(device.id, null);
    } catch (err) {
      if (err instanceof SquareMemberError) {
        if (device) flagPersonDevice(device.id, err.reason);
        const body = empty({
          ok: true,
          personId: person?.id ?? personId,
          event: "arrive",
          trigger: signal.trigger,
          applied: "rejected",
          reason: err.reason,
        });
        if (plan.replayKey) rememberReplay(plan.replayKey, 200, body, plan.replayTtlMs);
        return { status: 200, body };
      }
      throw err;
    }
  }

  if (plan.session && device) saveDeviceSession(device.id, plan.session);
  if (plan.watch && person) saveWatch(person.id, plan.watch);
  if (plan.journal && person && device) {
    recordPhoneEvent({
      personId: person.id,
      teamId: shopTeamId(),
      deviceId: device.id,
      event: signal.event,
      trigger: signal.trigger,
      at,
      receivedAt: now,
    });
  }
  if (plan.hold) earnEngine.holdWork(plan.hold.personId, plan.hold.at);
  if (plan.replayKey) rememberReplay(plan.replayKey, plan.status, plan.body, plan.replayTtlMs);
  return { status: plan.status, body: plan.body };
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
