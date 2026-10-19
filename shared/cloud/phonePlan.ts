import { RELAY_TTL_MS } from "../relayBox.ts";
import { deviceLatched, dropPhoneLatches, noteSight, type WatchPerson } from "./watch.ts";

export type PhoneSignal = {
  event: "arrive" | "leave";
  trigger: "geo" | "wifi";
  ts?: number;
  eventId?: string;
};

export type PhoneResponse = {
  ok: boolean;
  duplicate: boolean;
  personId: string | null;
  event: "arrive" | "leave" | null;
  trigger: "geo" | "wifi" | null;
  applied: "arrive" | "seen" | "exit" | "ignored" | "rejected";
  reason: string | null;
};

export type PhoneDevice = {
  id: string;
  personId: string;
  squareTeamMemberId: string;
  stationaryAt: number | null;
  sessionStart: number | null;
  squareFlag: string | null;
};

export type PhonePerson = {
  id: string;
  name: string;
  hourlyCents: number;
  squareTeamMemberId: string | null;
  consent: boolean;
};

export type PhoneShift = {
  clockedIn: boolean;
  holdAt: number | null;
  managedBy: "presence" | null;
};

export type PhonePlan = {
  status: number;
  body: PhoneResponse;
  replayKey?: string;
  replayTtlMs?: number;
  journal?: boolean;
  watch?: WatchPerson;
  session?: { sessionStart: number | null; lastSeenAt: number; stationaryAt: number | null };
  clockIn?: {
    person: { id: string; name: string; hourlyCents: number };
    at: number;
    source: "phone-geo" | "phone-wifi";
    clearFlag: boolean;
  };
  hold?: { personId: string; at: number };
  flag?: string | null;
};

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

export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function mentionsWage(raw: string): boolean {
  return /"(hourly_rate|hourlyCents|hourly|wage|amount)"\s*:/.test(raw);
}

export function clockTarget(
  person: { id: string; name: string; hourlyCents: number; squareTeamMemberId: string | null },
  device: { personId: string; squareTeamMemberId: string },
): { id: string; name: string; hourlyCents: number } | null {
  if (device.personId !== person.id) return null;
  const squareId = person.squareTeamMemberId ?? "";
  if (device.squareTeamMemberId !== squareId) return null;
  return { id: squareId || person.id, name: person.name, hourlyCents: person.hourlyCents };
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

/**
 * Decide what a phone arrive or leave does. Leave is not tied to the shop network:
 * a cellular post is enough. The same event id inside the dedupe window is a retry.
 */
export function planPhone(input: {
  now: number;
  signal: PhoneSignal;
  deviceId: string;
  personId: string;
  maxAgeMs: number;
  maxFutureMs: number;
  dedupeMs: number;
  inWindow: boolean;
  device: PhoneDevice | null;
  person: PhonePerson | null;
  watch: WatchPerson | null;
  shift: PhoneShift | null;
  quietMs: number;
  stationaryMs: number;
}): PhonePlan {
  const { signal, deviceId, personId } = input;
  const at = signal.ts ?? input.now;
  const timing =
    signal.ts == null
      ? "ok"
      : at - input.now > input.maxFutureMs
        ? "future_signal"
        : input.now - at > input.maxAgeMs
          ? "stale_signal"
          : "ok";
  const bucket = Math.floor(at / input.dedupeMs);
  const bucketKey = `phone:${deviceId}:${signal.trigger}:${signal.event}:${bucket}`;
  const eventKey = signal.eventId ? `phone:${deviceId}:evt:${signal.eventId}:${at}` : null;
  const replayKey = eventKey ?? bucketKey;
  const base = { personId, event: signal.event, trigger: signal.trigger };

  if (timing === "stale_signal") {
    return {
      status: 200,
      replayKey: bucketKey,
      body: empty({ ok: true, ...base, applied: "rejected", reason: timing }),
    };
  }
  if (timing !== "ok") {
    return {
      status: 200,
      replayKey,
      replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
      body: empty({ ok: true, ...base, applied: "rejected", reason: timing }),
    };
  }
  if (!input.inWindow) {
    return {
      status: 200,
      replayKey,
      replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
      body: empty({ ok: true, ...base, applied: "ignored", reason: "outside_hours" }),
    };
  }

  const device = input.device;
  const person = input.person;
  if (!device || !person) {
    return { status: 401, body: empty({ personId, applied: "rejected", reason: "unknown_device" }) };
  }
  if (!person.consent) {
    return {
      status: 403,
      replayKey,
      replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
      body: empty({ ok: false, personId: person.id, event: signal.event, trigger: signal.trigger, applied: "rejected", reason: "no_consent" }),
    };
  }
  if (device.stationaryAt != null) {
    return {
      status: 200,
      replayKey,
      replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
      body: empty({ ok: true, personId: person.id, event: signal.event, trigger: signal.trigger, applied: "ignored", reason: "stationary" }),
    };
  }

  const sourceId = `${device.id}:${signal.trigger}`;
  const latest = latestPhoneAt(input.watch, device.id);
  if (at < latest) {
    return {
      status: 200,
      replayKey,
      replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
      journal: true,
      body: empty({ ok: true, personId: person.id, event: signal.event, trigger: signal.trigger, applied: "ignored", reason: "out_of_order" }),
    };
  }

  if (signal.event === "arrive") {
    const still = deviceLatched(input.watch, device.id, input.now, input.quietMs);
    const sessionStart = still && device.sessionStart != null ? device.sessionStart : at;
    if (at - sessionStart >= input.stationaryMs) {
      return {
        status: 200,
        replayKey,
        replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
        journal: true,
        session: { sessionStart, lastSeenAt: at, stationaryAt: at },
        watch: noteSight(input.watch, { source: "phone", sourceId, at, present: false, latch: true }),
        body: empty({ ok: true, personId: person.id, event: signal.event, trigger: signal.trigger, applied: "ignored", reason: "stationary" }),
      };
    }
    const target = clockTarget(person, device);
    if (!target) {
      return {
        status: 200,
        replayKey,
        replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
        body: empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied: "rejected", reason: "square_mismatch" }),
      };
    }
    const source = signal.trigger === "wifi" ? "phone-wifi" : "phone-geo";
    const info = input.shift;
    const shouldIn = !info?.clockedIn || (info.managedBy !== "presence" && info.holdAt != null);
    const applied = info?.clockedIn && info.holdAt == null ? "seen" : "arrive";
    return {
      status: 200,
      replayKey,
      replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
      journal: true,
      session: { sessionStart, lastSeenAt: at, stationaryAt: null },
      watch: noteSight(input.watch, { source: "phone", sourceId, at, present: true, latch: true }),
      clockIn: shouldIn ? { person: target, at, source, clearFlag: Boolean(device.squareFlag) } : undefined,
      body: empty({ ok: true, personId: person.id, event: "arrive", trigger: signal.trigger, applied }),
    };
  }

  const marked = noteSight(input.watch, { source: "phone", sourceId, at, present: false, latch: true });
  const next = signal.trigger === "geo" ? dropPhoneLatches(marked, device.id, at) : marked;
  const latched = deviceLatched(next, device.id, input.now, input.quietMs);
  const target = clockTarget(person, device);
  const info = target ? input.shift : null;
  const hold = Boolean(target && info?.clockedIn && info.managedBy !== "presence" && !latched);
  return {
    status: 200,
    replayKey,
    replayTtlMs: eventKey ? RELAY_TTL_MS : undefined,
    journal: true,
    watch: next,
    session: latched ? undefined : { sessionStart: null, lastSeenAt: at, stationaryAt: null },
    hold: hold && target ? { personId: target.id, at } : undefined,
    body: empty({ ok: true, personId: person.id, event: "leave", trigger: signal.trigger, applied: "exit" }),
  };
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
  const posts = (event: "arrive" | "leave", trigger: "geo" | "wifi") => {
    const urls = event === "leave" ? [input.relayUrl!] : [input.url, input.relayUrl!];
    return urls.map((url) => [`POST ${url}`, header, body(event, trigger)].join("\n")).join("\n\n");
  };
  return [
    `Shop presence for ${input.name}`,
    "",
    "Capture the current time in milliseconds once. Use that same number as ts and eventId on every post of that firing.",
    "",
    "Header",
    header,
    "",
    "Arrive at the shop (location) — shop Wi-Fi and mailbox",
    posts("arrive", "geo"),
    "",
    "Leave the shop (location) — mailbox only, so cellular still clocks out",
    posts("leave", "geo"),
    "",
    "Joined the shop Wi-Fi — shop Wi-Fi and mailbox",
    posts("arrive", "wifi"),
    "",
    "Left the shop Wi-Fi — mailbox only",
    posts("leave", "wifi"),
    "",
    "Method is POST. Send the header on every request. The token is shown once.",
  ].join("\n");
}
