import assert from "node:assert/strict";
import { earnEngine } from "../clock/engine";
import { hourlyRateCents, snapshotFromInvoice, snapshotFromWebhook } from "./parse";
import { signaturesMatch, squareSignature } from "./signature";

const wage = hourlyRateCents({
  job_assignments: [
    {
      pay_type: "SALARY",
      hourly_rate: { amount: 1443, currency: "USD" },
    },
    {
      pay_type: "HOURLY",
      hourly_rate: { amount: 2800, currency: "USD" },
    },
  ],
});
assert.equal(wage, 2800);

const salaryOnly = hourlyRateCents({
  job_assignments: [
    { pay_type: "SALARY", hourly_rate: { amount: 2164, currency: "USD" } },
  ],
});
assert.equal(salaryOnly, 2164);

const paid = snapshotFromInvoice({
  id: "inv_booth",
  status: "PAID",
  title: "Booth rental",
  updated_at: "2026-09-30T20:00:00Z",
  payment_requests: [
    { total_completed_amount_money: { amount: 20000, currency: "USD" } },
  ],
});
assert.equal(paid?.centsPaid, 20000);
assert.equal(paid?.collected, true);
assert.equal(paid?.sent, true);
assert.equal(paid?.title, "Booth rental");

const draft = snapshotFromInvoice({ id: "inv_draft", status: "DRAFT" });
assert.equal(draft?.sent, false);
assert.equal(draft?.collected, false);

const unpaid = snapshotFromInvoice({ id: "inv_out", status: "UNPAID", title: "Follow up" });
assert.equal(unpaid?.sent, true);
assert.equal(unpaid?.collected, false);

const fromHook = snapshotFromWebhook({
  type: "invoice.payment_made",
  data: {
    object: {
      invoice: {
        id: "inv_hook",
        status: "PAID",
        title: "Big ticket",
        payment_requests: [
          { total_completed_amount_money: { amount: 20000, currency: "USD" } },
        ],
      },
    },
  },
});
assert.equal(fromHook?.id, "inv_hook");
assert.equal(fromHook?.collected, true);

const key = "test-key";
const url = "https://example.com/api/square/webhook";
const raw = JSON.stringify({ type: "invoice.published" });
const signed = squareSignature({ signatureKey: key, notificationUrl: url, rawBody: raw });
assert.equal(signaturesMatch(signed, signed), true);
assert.equal(signaturesMatch("nope", signed), false);

earnEngine.reset();
const first = earnEngine.ingestSquareInvoice({
  id: "inv_booth",
  status: "PAID",
  title: "Booth rental",
  centsPaid: 20000,
  sent: true,
  collected: true,
});
assert.deepEqual(first, { sale: true, points: true });
const state = earnEngine.getState();
assert.equal(state.session.outputCents, 0);
assert.equal(state.session.inputUnits, 1);
assert.equal(state.events[0]?.kind, "sale");
assert.equal(state.events[0]?.label, "+$200 Booth rental");
assert.equal(state.events[1]?.label, "+1");

const replay = earnEngine.ingestSquareInvoice({
  id: "inv_booth",
  status: "PAID",
  title: "Booth rental",
  centsPaid: 20000,
  sent: true,
  collected: true,
});
assert.deepEqual(replay, { sale: false, points: false });

earnEngine.applyWage(3200);
assert.equal(earnEngine.getState().config.hourlyOutputCents, 3200);
assert.deepEqual(earnEngine.getState().square, { connected: true, source: "square" });

console.log("square parse tests ok");
