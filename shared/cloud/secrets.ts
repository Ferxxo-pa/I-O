import { base64ToBytes, bytesToBase64 } from "./hmac.ts";

/** AES-GCM for Square tokens at rest. The key is a wrangler secret, never the database. */

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function keyFromBase64(value: string): Uint8Array {
  const bytes = base64ToBytes(value.trim());
  if (bytes.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes");
  return bytes;
}

export async function sealSecret(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv);
  packed.set(cipher, iv.length);
  return bytesToBase64(packed);
}

export async function openSecret(key: CryptoKey, sealed: string): Promise<string> {
  const packed = base64ToBytes(sealed);
  if (packed.length < 13) throw new Error("Sealed value is unreadable");
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
