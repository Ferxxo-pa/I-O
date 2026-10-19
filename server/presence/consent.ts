import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ConsentRow = {
  consentedAt: number;
  revokedAt: number | null;
};

type ConsentFile = { version: 1; people: Record<string, ConsentRow> };

export function readConsent(file: string): Record<string, ConsentRow> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { people?: Record<string, ConsentRow> };
    const people: Record<string, ConsentRow> = {};
    for (const [id, row] of Object.entries(parsed.people ?? {})) {
      if (!row || typeof row.consentedAt !== "number") continue;
      people[id] = { consentedAt: row.consentedAt, revokedAt: row.revokedAt ?? null };
    }
    return people;
  } catch {
    return {};
  }
}

function writeConsent(file: string, people: Record<string, ConsentRow>) {
  mkdirSync(dirname(file), { recursive: true });
  const body: ConsentFile = { version: 1, people };
  writeFileSync(file, JSON.stringify(body));
}

export function consentActive(people: Record<string, ConsentRow>, personId: string): boolean {
  const row = people[personId];
  if (!row) return false;
  if (row.revokedAt == null) return true;
  return row.consentedAt > row.revokedAt;
}

export function setConsent(file: string, personId: string, consent: boolean, now: number): ConsentRow {
  const people = readConsent(file);
  const current = people[personId];
  const row: ConsentRow = consent
    ? { consentedAt: now, revokedAt: null }
    : { consentedAt: current?.consentedAt ?? now, revokedAt: now };
  people[personId] = row;
  writeConsent(file, people);
  return row;
}
