import assert from "node:assert/strict";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, test } from "vitest";
import { shopDateStart } from "../../shared/presence.ts";
import { hmacSha256Base64 } from "../../shared/cloud/hmac.ts";
import { openBackup } from "../../shared/cloud/backup.ts";
import { importAesKey, keyFromBase64 } from "../../shared/cloud/secrets.ts";
import worker from "../src/index.ts";

const day = shopDateStart("2026-10-19");
const ten = day + 10 * 60 * 60 * 1000;
const noon = day + 12 * 60 * 60 * 1000;
const evening = day + (19 * 60 + 1) * 60 * 1000;
const TOKEN = "sq_live_do_not_store_plain";
const HOOK = "hook-signature-key";

beforeAll(async () => {
  const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations);
});

function headers(extra: Record<string, string> = {}): HeadersInit {
  return { "content-type": "application/json", ...extra };
}

async function api(path: string, init: RequestInit = {}) {
  const res = await SELF.fetch(`https://io.example${path}`, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function shop(name: string) {
  const created = await api("/api/company", { method: "POST", headers: headers(), body: JSON.stringify({ name }) });
  const id = String(created.body.id);
  const ownerKey = String(created.body.ownerKey);
  const auth = headers({ "x-company-id": id, "x-owner-key": ownerKey, "x-io-now": String(ten) });
  await api("/api/fight/pin", { method: "POST", headers: auth, body: JSON.stringify({ pin: "2468" }) });
  const pin = headers({ ...Object.fromEntries(new Headers(auth).entries()), "x-shop-pin": "2468" });
  return { id, ownerKey, auth: pin };
}

test("a shop day stays one timecard per person and stays inside the shop", async () => {
  const adaShop = await shop("EZ Designs");
  const other = await shop("Other Shop");
  await api("/api/company/square", {
    method: "POST",
    headers: adaShop.auth,
    body: JSON.stringify({ token: TOKEN, webhookKey: HOOK, locationId: "L1" }),
  });

  for (const person of [
    { name: "Ada Lovelace", squareTeamMemberId: "tm-ada" },
    { name: "Ben Wright", squareTeamMemberId: "tm-ben" },
  ]) {
    await api("/api/company/people", { method: "POST", headers: adaShop.auth, body: JSON.stringify({ ...person, hourlyCents: 2000 }) });
    await api("/api/presence/consent", {
      method: "POST",
      headers: adaShop.auth,
      body: JSON.stringify({ personId: person.squareTeamMemberId, note: "yes" }),
    });
  }

  const adaSetup = await api("/api/presence/phone/setup", {
    method: "POST",
    headers: adaShop.auth,
    body: JSON.stringify({ personId: "tm-ada" }),
  });
  const benSetup = await api("/api/presence/phone/setup", {
    method: "POST",
    headers: adaShop.auth,
    body: JSON.stringify({ personId: "tm-ben" }),
  });
  const adaInvite = String(adaSetup.body.inviteUrl).split("/join/")[1];
  const benInvite = String(benSetup.body.inviteUrl).split("/join/")[1];
  const adaOpen = await api(`/join/${adaInvite}/open`, { method: "POST", headers: headers({ "x-io-now": String(ten) }) });
  const benOpen = await api(`/join/${benInvite}/open`, { method: "POST", headers: headers({ "x-io-now": String(ten) }) });
  const adaToken = String(adaOpen.body.token);
  const benToken = String(benOpen.body.token);
  assert.equal(adaOpen.status, 200);
  assert.ok(adaToken.length > 10);

  const arrive = (token: string, trigger: "geo" | "wifi", at: number, eventId: string) =>
    api("/api/presence/phone", {
      method: "POST",
      headers: headers({ authorization: `Bearer ${token}`, "x-company-id": adaShop.id, "x-io-now": String(at) }),
      body: JSON.stringify({ event: "arrive", trigger, ts: at, eventId }),
    });

  const adaIn = await arrive(adaToken, "geo", ten, "evt-ada-arrive");
  const benIn = await arrive(benToken, "wifi", ten + 5 * 60 * 1000, "evt-ben-arrive");
  assert.equal(adaIn.body.applied, "arrive");
  assert.equal(benIn.body.applied, "arrive");

  const adaLeave = await api("/api/presence/phone", {
    method: "POST",
    headers: headers({ authorization: `Bearer ${adaToken}`, "x-io-now": String(noon) }),
    body: JSON.stringify({ event: "leave", trigger: "geo", ts: noon, eventId: "evt-ada-leave" }),
  });
  assert.equal(adaLeave.body.applied, "exit");
  const adaAgain = await api("/api/presence/phone", {
    method: "POST",
    headers: headers({ authorization: `Bearer ${adaToken}`, "x-io-now": String(noon + 1000) }),
    body: JSON.stringify({ event: "leave", trigger: "geo", ts: noon, eventId: "evt-ada-leave" }),
  });
  assert.equal(adaAgain.body.duplicate, true);

  const crossed = await api("/api/presence/phone", {
    method: "POST",
    headers: headers({ authorization: `Bearer ${adaToken}`, "x-company-id": other.id, "x-io-now": String(noon) }),
    body: JSON.stringify({ event: "leave", trigger: "geo", ts: noon, eventId: "evt-ada-leave-2" }),
  });
  assert.equal(crossed.status, 403);

  const hookUrl = `https://io.example/api/square/webhook/${adaShop.id}`;
  const cardBody = JSON.stringify({
    type: "labor.timecard.created",
    data: { object: { timecard: { id: "tc-extra", team_member_id: "tm-ben", status: "OPEN", start_at: new Date(ten).toISOString() } } },
  });
  const signed = hmacSha256Base64(HOOK, hookUrl + cardBody);
  const hooked = await api(`/api/square/webhook/${adaShop.id}`, {
    method: "POST",
    headers: headers({ "x-square-hmacsha256-signature": signed, "x-io-now": String(noon) }),
    body: cardBody,
  });
  assert.equal(hooked.status, 200);

  const invoice = JSON.stringify({
    type: "invoice.payment_made",
    data: { object: { invoice: { id: "inv-1", status: "PAID", payment_requests: [{ total_completed_amount_money: { amount: 20000 } }] } } },
  });
  const invoiceSig = hmacSha256Base64(HOOK, hookUrl + invoice);
  await api(`/api/square/webhook/${adaShop.id}`, {
    method: "POST",
    headers: headers({ "x-square-hmacsha256-signature": invoiceSig, "x-io-now": String(noon) }),
    body: invoice,
  });
  await api(`/api/square/webhook/${adaShop.id}`, {
    method: "POST",
    headers: headers({ "x-square-hmacsha256-signature": invoiceSig, "x-io-now": String(noon + 1) }),
    body: invoice,
  });

  const ctx = { waitUntil() {}, passThroughOnException() {} };
  await worker.scheduled({ cron: "* * * * *", scheduledTime: evening, type: "scheduled" } as ScheduledController, env, ctx as ExecutionContext);

  const after = await api("/api/state", {
    method: "GET",
    headers: headers({ "x-company-id": adaShop.id, "x-shop-pin": "2468", "x-person-id": "tm-ben", "x-io-now": String(evening) }),
  });
  assert.equal(after.status, 200);
  const session = after.body.session as { clockedIn?: boolean; collectedCents?: number };
  assert.equal(session.clockedIn, false);
  assert.equal(session.collectedCents, 20000);

  const log = await api("/api/test/square", { headers: headers({ "x-company-id": adaShop.id, "x-owner-key": adaShop.ownerKey }) });
  const calls = log.body.calls as Array<{ method: string; path: string }>;
  const creates = calls.filter((call) => call.method === "POST" && call.path === "/v2/labor/timecards");
  assert.equal(creates.length, 2);
  assert.equal(calls.some((call) => /wage-setting/i.test(call.path) && call.method !== "GET"), false);
  assert.equal(log.body.open, 0);

  const otherState = await api("/api/state", {
    headers: headers({ "x-company-id": other.id, "x-shop-pin": "2468", "x-io-now": String(evening) }),
  });
  const crew = ((otherState.body.ops as { crew?: Array<{ name: string }> }).crew) ?? [];
  assert.equal(crew.some((mate) => mate.name.includes("Ada")), false);

  const audit = await api("/api/test/audit", { headers: headers({ "x-company-id": adaShop.id, "x-owner-key": adaShop.ownerKey }) });
  const dumped = JSON.stringify(audit.body);
  assert.equal(dumped.includes("Ada"), false);
  assert.equal(dumped.includes(TOKEN), false);
  assert.equal(dumped.includes(adaToken), false);

  const evil = await api("/api/state", {
    headers: headers({ "x-company-id": adaShop.id, "x-shop-pin": "2468", origin: "https://evil.example" }),
  });
  assert.equal(evil.status, 403);

  await worker.scheduled({ cron: "0 8 * * *", scheduledTime: evening, type: "scheduled" } as ScheduledController, env, ctx as ExecutionContext);
  const object = await env.BACKUPS.get(`backups/${new Date(evening).toISOString().slice(0, 10)}.json.enc`);
  assert.ok(object);
  const key = await importAesKey(keyFromBase64(env.BACKUP_KEY!));
  const plain = await openBackup(key, new Uint8Array(await object!.arrayBuffer()));
  assert.equal(plain.includes(TOKEN), false);
});
