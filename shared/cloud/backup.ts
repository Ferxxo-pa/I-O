import { openSecret, sealSecret } from "./secrets.ts";

/**
 * Nightly dump. Square tokens stay in the ciphertext column they already use.
 * The whole file is sealed again before it lands in R2.
 */

export type BackupTable = { name: string; rows: unknown[] };

export function backupDocument(tables: readonly BackupTable[], at: number): string {
  return JSON.stringify({ version: 1, at, tables });
}

export async function sealBackup(key: CryptoKey, document: string): Promise<Uint8Array> {
  const sealed = await sealSecret(key, document);
  return new TextEncoder().encode(sealed);
}

export async function openBackup(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  return openSecret(key, new TextDecoder().decode(bytes));
}

/** Plaintext tokens must not appear in a dump. Ciphertext columns are fine. */
export function dumpLeaksPlainToken(document: string, plainToken: string): boolean {
  if (!plainToken) return false;
  return document.includes(plainToken);
}
