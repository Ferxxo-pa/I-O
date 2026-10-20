import { parseRelayPayload, type RelayPayload } from "@shared/relayBox";
import { RELAY_TTL_MS, ioMode, relaySecrets } from "../mode";
import { applyPhoneSignal } from "../presence/phone";
import { personForTokenHash } from "../presence/service";
import { squareConfigured } from "../square/client";
import { kickSquareSync } from "../square/sync";

type Pulled = {
  id?: unknown;
  deviceKey?: unknown;
  event?: unknown;
  trigger?: unknown;
  ts?: unknown;
  eventId?: unknown;
};

type PulledHook = {
  id?: unknown;
};

let timer: ReturnType<typeof setInterval> | null = null;
let pulling = false;

export function startRelayPoll() {
  if (timer || ioMode() !== "local-relay" || !relaySecrets()) return;
  const ms = Number(process.env.RELAY_POLL_MS);
  const every = Number.isFinite(ms) && ms >= 1000 ? ms : 5000;
  timer = setInterval(() => {
    void pollRelayOnce();
  }, every);
  timer.unref();
}

export function stopRelayPoll() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function pollRelayOnce(): Promise<{ applied: number; rejected: number }> {
  if (pulling) return { applied: 0, rejected: 0 };
  const secrets = ioMode() === "local-relay" ? relaySecrets() : null;
  if (!secrets) return { applied: 0, rejected: 0 };
  pulling = true;
  try {
    const headers = { authorization: `Bearer ${secrets.secret}` };
    const res = await fetch(`${secrets.url}/pull`, { headers });
    if (!res.ok) return { applied: 0, rejected: 0 };
    const body = (await res.json().catch(() => ({}))) as { messages?: Pulled[]; hooks?: PulledHook[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const ack: string[] = [];
    const opened: Array<{ id: string; deviceKey: string; payload: RelayPayload }> = [];
    let rejected = 0;
    for (const msg of messages) {
      const id = typeof msg?.id === "string" ? msg.id : "";
      const deviceKey = typeof msg?.deviceKey === "string" ? msg.deviceKey : "";
      if (!id) continue;
      const payload = parseRelayPayload({
        event: msg?.event,
        trigger: msg?.trigger,
        ts: msg?.ts,
        eventId: msg?.eventId,
      });
      if (!payload || !deviceKey) {
        ack.push(id);
        rejected += 1;
        continue;
      }
      opened.push({ id, deviceKey, payload });
    }
    opened.sort((a, b) => a.payload.ts - b.payload.ts || a.payload.eventId.localeCompare(b.payload.eventId));
    let applied = 0;
    for (const row of opened) {
      try {
        const who = personForTokenHash(row.deviceKey);
        if (!who) {
          ack.push(row.id);
          rejected += 1;
          continue;
        }
        await applyPhoneSignal({
          deviceId: who.deviceId,
          personId: who.personId,
          signal: row.payload,
          maxAgeMs: RELAY_TTL_MS,
        });
        ack.push(row.id);
        applied += 1;
      } catch {
        // Leave it in the mailbox. The next poll tries the write again.
      }
    }
    const hooks = Array.isArray(body.hooks) ? body.hooks : [];
    let sawHook = false;
    for (const hook of hooks) {
      const id = typeof hook?.id === "string" ? hook.id : "";
      if (!/^[a-f0-9]{64}$/.test(id)) continue;
      ack.push(id);
      sawHook = true;
    }
    if (sawHook && squareConfigured()) kickSquareSync();
    if (ack.length > 0) {
      await fetch(`${secrets.url}/ack`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ids: ack }),
      });
    }
    return { applied, rejected };
  } catch {
    return { applied: 0, rejected: 0 };
  } finally {
    pulling = false;
  }
}
