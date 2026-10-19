import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { deviceKey, mailboxId } from "../shared/thinBox.ts";
import { handleRelay, resetRelayLimits, type RelayDb, type RelayEnv } from "./src/index.ts";

type Box = {
  id: string;
  device_key: string;
  event: string;
  trigger: string;
  ts: number;
  event_id: string;
  received_at: number;
  expires_at: number;
};
type Hook = {
  id: string;
  kind: string;
  entity_id: string;
  team_member_id: string;
  ts: number;
  received_at: number;
  expires_at: number;
};

function memoryDb(): RelayDb & { rows: Box[]; hooks: Hook[] } {
  const rows: Box[] = [];
  const hooks: Hook[] = [];
  return {
    rows,
    hooks,
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      const hookTable = text.includes("hooks");
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (text.startsWith("INSERT") && hookTable) {
                const [id, kind, entity_id, team_member_id, ts, received_at, expires_at] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  number,
                ];
                if (!hooks.some((row) => row.id === id)) hooks.push({ id, kind, entity_id, team_member_id, ts, received_at, expires_at });
              } else if (text.startsWith("INSERT")) {
                const [id, device_key, event, trigger, ts, event_id, received_at, expires_at] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  string,
                  number,
                  number,
                ];
                if (!rows.some((row) => row.id === id)) {
                  rows.push({ id, device_key, event, trigger, ts, event_id, received_at, expires_at });
                }
              }
              return { success: true };
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

const token = "io_mailbox_phone";
const payload = { event: "leave", trigger: "geo", ts: 1_700_000_000_000, eventId: "leave-cell-1" };
const db = memoryDb();
const env: RelayEnv = { DB: db, RELAY_SHOP_SECRET: "shop-secret" };
resetRelayLimits();
const wage = await handleRelay(
  new Request("https://mailbox.example/drop", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...payload, given_name: "Ada", hourly_rate: { amount: 2400 } }),
  }),
  env,
  1_000,
);
assert.equal(wage.status, 400);
assert.equal(db.rows.length, 0);
const posted = await handleRelay(
  new Request("https://mailbox.example/drop", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }),
  env,
  1_000,
);
assert.equal(posted.status, 200);
assert.equal(db.rows.length, 1);
assert.equal(JSON.stringify(db.rows).includes(token), false);
assert.equal(JSON.stringify(db.rows).includes("Ada"), false);
assert.equal(db.rows[0].id, await mailboxId(await deviceKey(token), payload.eventId));
const off = await handleRelay(new Request("https://mailbox.example/square", { method: "POST", body: "{}" }), env, 1_000);
assert.equal(off.status, 404);
env.RELAY_SQUARE_WEBHOOK_KEY = "sign-key";
env.RELAY_SQUARE_NOTIFICATION_URL = "https://mailbox.example/square";
const hookBody = JSON.stringify({
  type: "labor.timecard.created",
  created_at: "2026-10-14T14:00:00Z",
  data: { id: "tc-1", object: { timecard: { id: "tc-1", team_member_id: "TM1", given_name: "Ada", hourly_rate: { amount: 2400 } } } },
});
const sig = createHmac("sha256", "sign-key").update(`https://mailbox.example/square${hookBody}`).digest("base64");
const hooked = await handleRelay(
  new Request("https://mailbox.example/square", {
    method: "POST",
    headers: { "x-square-hmacsha256-signature": sig },
    body: hookBody,
  }),
  env,
  1_000,
);
assert.equal(hooked.status, 200);
assert.equal(JSON.stringify(db.hooks).includes("Ada"), false);
assert.equal(JSON.stringify(db.hooks).includes("2400"), false);
assert.equal(db.hooks[0].team_member_id, "TM1");
console.log("mailbox ok");
