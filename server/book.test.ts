import assert from "node:assert/strict";
import { barSplit, businessDate, signedMoney } from "@shared/book";
import { CompanyBook } from "./book";
import { netFromPayment } from "./square/parse";

const split = barSplit(90000, 60000);
assert.equal(split.balanceCents, 30000);
assert.equal(split.green, 60);
assert.equal(split.red, 40);
assert.equal(split.neutral, false);
assert.equal(split.tie, false);
assert.equal(signedMoney(split.balanceCents), "+$300");
assert.equal(signedMoney(-6000), "−$60");

const empty = barSplit(0, 0);
assert.equal(empty.neutral, true);
assert.equal(empty.green, 0);
assert.equal(empty.red, 0);

const tie = barSplit(4000, 4000);
assert.equal(tie.tie, true);
assert.equal(tie.green, 50);
assert.equal(tie.red, 50);
assert.equal(tie.balanceCents, 0);

const lateUtc = Date.parse("2026-03-15T04:30:00Z");
assert.equal(businessDate(lateUtc), "2026-03-14");
assert.equal(businessDate(Date.parse("2026-03-15T05:30:00Z")), "2026-03-15");

const book = new CompanyBook();
const day = Date.parse("2026-10-03T18:00:00Z");
assert.equal(book.record({ sourceId: "cash:1", contributionCents: 90000, at: day })?.label, "+$900");
assert.equal(book.record({ sourceId: "cash:1", contributionCents: 90000, at: day }), null);
assert.equal(book.record({ sourceId: "expense:1", contributionCents: -60000, at: day })?.label, "−$600");
assert.equal(
  book.record({ sourceId: "expense:invest", contributionCents: -500000, category: "investment", at: day }),
  null,
);

const view = book.view(day);
assert.equal(view.plusCents, 90000);
assert.equal(view.minusCents, 60000);
assert.equal(view.balanceCents, 30000);
assert.equal(view.green, 60);
assert.equal(view.red, 40);
assert.equal(signedMoney(view.balanceCents), "+$300");

const payment = netFromPayment({
  id: "pay_1",
  status: "COMPLETED",
  amount_money: { amount: 10000, currency: "USD" },
  processing_fee: [{ amount_money: { amount: 290, currency: "USD" }, type: "INITIAL" }],
  created_at: "2026-10-03T18:00:00Z",
});
assert.equal(payment?.netCents, 9710);
assert.equal(payment?.feeCents, 290);

const again = netFromPayment({
  id: "pay_1",
  status: "COMPLETED",
  amount_money: { amount: 10000, currency: "USD" },
  processing_fee: [
    { amount_money: { amount: 290, currency: "USD" }, type: "INITIAL" },
    { amount_money: { amount: 10, currency: "USD" }, type: "ADJUSTMENT" },
  ],
  processing_fee_money: { amount: 290, currency: "USD" },
  created_at: "2026-10-03T18:00:00Z",
});
assert.equal(again?.feeCents, 300);
assert.equal(again?.netCents, 9700);

const fees = new CompanyBook();
assert.ok(payment);
fees.record({ sourceId: payment.sourceId, contributionCents: payment.netCents, at: day });
fees.record({ sourceId: payment.sourceId, contributionCents: payment.netCents, at: day });
assert.equal(fees.view(day).plusCents, 9710);

const refunded = netFromPayment({
  id: "pay_1",
  status: "COMPLETED",
  amount_money: { amount: 10000, currency: "USD" },
  processing_fee: [{ amount_money: { amount: 290, currency: "USD" } }],
  refunded_money: { amount: 10000, currency: "USD" },
  created_at: "2026-10-03T18:00:00Z",
});
assert.equal(refunded?.netCents, -290);
const flash = fees.record({
  sourceId: payment.sourceId,
  contributionCents: refunded!.netCents,
  at: day,
});
assert.equal(flash?.label, "−$100");
assert.equal(fees.view(day).balanceCents, -290);

console.log("book tests ok");
