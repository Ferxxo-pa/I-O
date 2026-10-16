import assert from "node:assert/strict";
import { assertShopPin, hashPin, pinShape, resetPinAttempts, verifyPin } from "./pin.ts";

assert.equal(pinShape("2468"), true);
assert.equal(pinShape("123"), false);
assert.equal(pinShape("abcd"), false);
assert.equal(pinShape("123456789"), false);

const hash = hashPin("2468");
assert.equal(hash.startsWith("scrypt$"), true);
assert.equal(hash.includes("2468"), false);
assert.equal(verifyPin("2468", hash), true);
assert.equal(verifyPin("2469", hash), false);
assert.equal(verifyPin("nope", hash), false);
assert.equal(verifyPin("2468", "plain"), false);

resetPinAttempts();
let denied = 0;
for (let i = 0; i < 5; i++) {
  try {
    assertShopPin("0000", "test-ip", true, () => false);
  } catch (err) {
    denied += 1;
    assert.equal(err instanceof Error ? err.message : "", "Wrong PIN");
  }
}
assert.equal(denied, 5);
try {
  assertShopPin("0000", "test-ip", true, () => false);
  assert.fail("sixth failure should lock");
} catch (err) {
  assert.equal(err instanceof Error ? err.message : "", "Too many tries");
}
try {
  assertShopPin("2468", "test-ip", true, (pin) => pin === "2468");
  assert.fail("lock should hold for a correct PIN too");
} catch (err) {
  assert.equal(err instanceof Error ? err.message : "", "Too many tries");
}

resetPinAttempts();
assert.doesNotThrow(() => assertShopPin("2468", "fresh", true, (pin) => pin === "2468"));
try {
  assertShopPin("2468", "fresh", false, () => true);
  assert.fail("missing pin setup should be refused");
} catch (err) {
  assert.equal(err instanceof Error ? err.message : "", "Set a shop PIN");
}

console.log("pin ok");
