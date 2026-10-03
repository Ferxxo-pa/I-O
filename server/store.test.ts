import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-store-"));
delete process.env.HOUR_DURATION_MS;

const { startPersistence, flushState } = await import("./persist.ts");
const { earnEngine } = await import("./clock/engine.ts");
const { createCompany, getCompany, hydrateCompany } = await import("./company.ts");

startPersistence();

assert.equal(earnEngine.getState().config.hourDurationMs, 3_600_000);

earnEngine.applyWage(3000);
assert.equal(earnEngine.getState().config.hourlyOutputCents, 3000);
earnEngine.setConfig({ hourlyOutputCents: 2500 });
earnEngine.applyWage(4000);
assert.equal(earnEngine.getState().config.hourlyOutputCents, 4000);

const company = createCompany("North");
assert.equal(company.name, "North");
assert.match(company.code ?? "", /^[A-Z2-9]{6}$/);

await earnEngine.clockInPerson({ id: "ada", name: "Ada", hourlyCents: 2000 });
assert.equal(earnEngine.getState("ada").session.clockedIn, true);
assert.equal(earnEngine.getState("ben").session.clockedIn, false);

earnEngine.markSquareInvoiceSeen({
  id: "inv_old",
  status: "PAID",
  centsPaid: 20000,
  sent: true,
  collected: true,
});
earnEngine.markSquareBootstrapped();
const collected = earnEngine.getState().session.collectedCents;
const points = earnEngine.getState().session.inputUnits;
earnEngine.ingestSquareInvoice({
  id: "inv_old",
  status: "PAID",
  centsPaid: 20000,
  sent: true,
  collected: true,
});
assert.equal(earnEngine.getState().session.collectedCents, collected);
assert.equal(earnEngine.getState().session.inputUnits, points);

flushState();
const saved = JSON.parse(readFileSync(join(process.env.DATA_DIR, "io-state.json"), "utf8"));
assert.equal(saved.version, 1);
assert.equal(saved.company.name, "North");
assert.equal(saved.session.clockedIn, false);
assert.equal(saved.shifts[0].personId, "ada");
assert.equal(saved.shifts[0].clockedIn, true);
assert.equal(saved.squareBootstrapped, true);
assert.ok(saved.seen.includes("sale:inv_old"));

earnEngine.setBookListener(() => {});
const { setCompanyListener } = await import("./company.ts");
setCompanyListener(() => {});
earnEngine.reset();
hydrateCompany({ name: null, code: null, people: [] });
assert.equal(earnEngine.getState("ada").session.clockedIn, false);
assert.equal(getCompany().name, null);

const { loadState } = await import("./persist.ts");
loadState();
assert.equal(getCompany().name, "North");
assert.equal(earnEngine.getState("ada").session.clockedIn, true);
assert.equal(earnEngine.isSquareBootstrapped(), true);

console.log("store ok");
