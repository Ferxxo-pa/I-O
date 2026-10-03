import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "io-shifts-"));
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.HOUR_DURATION_MS;

const { earnEngine } = await import("./clock/engine.ts");

earnEngine.setConfig({ hourDurationMs: 40 });
earnEngine.start();

await earnEngine.clockInPerson({ id: "ada", name: "Ada", hourlyCents: 2000 });
await earnEngine.clockInPerson({ id: "ben", name: "Ben", hourlyCents: 4000 });
await new Promise((resolve) => setTimeout(resolve, 600));

const ada = earnEngine.getState("ada");
const ben = earnEngine.getState("ben");
assert.equal(ada.session.clockedIn, true);
assert.equal(ben.session.clockedIn, true);
assert.equal(ada.you.name, "Ada");
assert.equal(ben.you.name, "Ben");
assert.equal(ada.session.outputCents, ben.session.outputCents);
assert.equal(ada.accruedOutputCents, ben.accruedOutputCents);
const running = ada.session.outputCents + ada.accruedOutputCents;
assert.ok(running >= 2000 + 4000, `both wages should add together, got ${running}`);

await earnEngine.clockOutPerson("ada");
const adaOut = earnEngine.getState("ada");
const benStill = earnEngine.getState("ben");
assert.equal(adaOut.session.clockedIn, false);
assert.equal(benStill.session.clockedIn, true);
assert.equal(adaOut.session.outputCents, benStill.session.outputCents);
assert.equal(adaOut.accruedOutputCents, benStill.accruedOutputCents);
assert.ok(benStill.session.outputCents + benStill.accruedOutputCents >= running);

await earnEngine.clockOutPerson("ben");
const doneAda = earnEngine.getState("ada");
const doneBen = earnEngine.getState("ben");
assert.equal(doneAda.session.clockedIn, false);
assert.equal(doneBen.session.clockedIn, false);
assert.equal(doneAda.accruedOutputCents, 0);
assert.equal(doneAda.session.outputCents, doneBen.session.outputCents);
assert.ok(doneAda.session.outputCents >= 6000);

earnEngine.syncRemoteTimecard({
  personId: "TM1",
  name: "Square",
  hourlyCents: 1500,
  timecardId: "card-1",
  open: true,
  startedAt: Date.now() - 10,
});
assert.equal(earnEngine.getState("TM1").session.clockedIn, true);
assert.equal(earnEngine.getState("ada").session.clockedIn, false);
assert.ok(earnEngine.getState("ada").accruedOutputCents >= 0);
const withSquare = earnEngine.getState("ada");
assert.equal(withSquare.session.outputCents, earnEngine.getState("TM1").session.outputCents);

earnEngine.syncRemoteTimecard({
  personId: "TM1",
  name: "Square",
  hourlyCents: 1500,
  timecardId: "card-1",
  open: false,
  startedAt: Date.now() - 10,
});
assert.equal(earnEngine.getState("TM1").session.clockedIn, false);
assert.equal(earnEngine.getState("ada").session.clockedIn, false);

earnEngine.stop();
console.log("shifts ok");
