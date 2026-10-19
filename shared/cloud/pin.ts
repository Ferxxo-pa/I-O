import { base64ToBytes, bytesToBase64, signaturesMatch } from "./hmac.ts";

const ITERATIONS = 10_000;

export function pinShape(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

async function pbkdf2(pin: string, salt: Uint8Array, iterations = ITERATIONS): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Hosted shops store this form. The shop PC keeps its scrypt hashes. */
export async function hashPin(pin: string): Promise<string> {
  if (!pinShape(pin)) throw new Error("PIN is 4 to 8 digits");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt);
  return `pbkdf2$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPbkdf2(pin: string, stored: string): Promise<boolean> {
  if (!pinShape(pin)) return false;
  const [kind, rounds, salt, hash] = stored.split("$");
  if (kind !== "pbkdf2" || !rounds || !salt || !hash) return false;
  const iterations = Number(rounds);
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > 100_000) return false;
  const next = await pbkdf2(pin, base64ToBytes(salt), iterations);
  return signaturesMatch(bytesToBase64(next), hash);
}
