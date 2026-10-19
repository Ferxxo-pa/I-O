import { openBox, type RelayPayload } from "@shared/relayBox";
import { RELAY_TTL_MS, ioMode, relaySecrets } from "../mode";
import { applyPhoneSignal } from "../presence/phone";
import { personForTokenHash } from "../presence/service";

type Pulled = {
  id?: unknown;
  deviceKey?: unknown;
  envelope?: unknown;
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
    const body = (await res.json().catch(() => ({}))) as { messages?: Pulled[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const ack: string[] = [];
    const opened: Array<{ id: string; deviceKey: string; payload: RelayPayload }> = [];
    let rejected = 0;
    for (const msg of messages) {
      const id = typeof msg?.id === "string" ? msg.id : "";
      const envelope = typeof msg?.envelope === "string" ? msg.envelope : "";
      const deviceKey = typeof msg?.deviceKey === "string" ? msg.deviceKey : "";
      if (!id) continue;
      const payload = envelope ? await openBox(secrets.privateJwk, envelope) : null;
      if (!payload) {
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
