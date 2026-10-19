import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  checksumLine,
  checksumMatches,
  chooseRelease,
  inInstallWindow,
  nextBootAction,
  planUpdate,
  verifySignature,
} from "../scripts/update-lib.mjs";

const releases = [
  { version: "0.2.0", draft: false, prerelease: false },
  { version: "0.3.0-beta.1", draft: false, prerelease: true },
  { version: "0.9.0", draft: true, prerelease: false },
  { version: "0.1.5", draft: false, prerelease: false },
];

assert.equal(chooseRelease(releases, "stable", "0.1.0")?.version, "0.2.0");
assert.equal(chooseRelease(releases, "beta", "0.2.0")?.version, "0.3.0-beta.1");
assert.equal(chooseRelease(releases, "stable", "0.2.0"), null);
assert.equal(chooseRelease(releases, "beta", "0.9.0"), null);

const bytes = Buffer.from("io-release");
const sha = "6f3c4d1e0a0e5e5a0d8c1b7e9f2a4c6d8e0b1a2c3d4e5f60718293a4b5c6d7e8";
assert.equal(checksumMatches(sha, bytes), false);
const real = createHash("sha256").update(bytes).digest("hex");
assert.equal(checksumMatches(real, bytes), true);
assert.equal(checksumMatches(`${real.slice(0, -1)}0`, bytes), false);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const line = checksumLine(real, "io-0.2.0.tar.gz");
const signature = sign(null, Buffer.from(line), privateKey);
assert.equal(verifySignature(pem, line, signature), true);
const flipped = Buffer.from(signature);
flipped[0] ^= 0xff;
assert.equal(verifySignature(pem, line, flipped), false);
assert.equal(verifySignature("not-a-key", line, signature), false);

const inside = Date.UTC(2026, 9, 19, 7, 30);
const before = Date.UTC(2026, 9, 19, 6, 0);
const after = Date.UTC(2026, 9, 19, 9, 0);
assert.equal(inInstallWindow(inside, "02:15", "America/Chicago", 90), true);
assert.equal(inInstallWindow(before, "02:15", "America/Chicago", 90), false);
assert.equal(inInstallWindow(after, "02:15", "America/Chicago", 90), false);

assert.equal(nextBootAction(null, false), "ok");
assert.equal(nextBootAction({ version: "0.2.0" }, true), "ok");
assert.equal(nextBootAction({ version: "0.2.0" }, false), "rollback");
assert.equal(nextBootAction({ version: "0.2.0", rolledBack: true }, false), "ok");

assert.equal(
  planUpdate({
    enabled: false,
    channel: "stable",
    current: "0.1.0",
    releases,
    now: inside,
    at: "02:15",
    tz: "America/Chicago",
    windowMin: 90,
    applyNow: "",
  }).action,
  "skip",
);
assert.equal(
  planUpdate({
    enabled: true,
    channel: "stable",
    current: "0.1.0",
    releases,
    now: before,
    at: "02:15",
    tz: "America/Chicago",
    windowMin: 90,
    applyNow: "",
  }).action,
  "wait",
);
assert.equal(
  planUpdate({
    enabled: true,
    channel: "stable",
    current: "0.1.0",
    releases,
    now: before,
    at: "02:15",
    tz: "America/Chicago",
    windowMin: 90,
    applyNow: "now",
  }).action,
  "install",
);

console.log("update ok");
