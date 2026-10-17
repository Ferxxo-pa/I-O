import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { punchRecordSchema, type PunchRecord } from "@shared/presence";

export function readPunchLog(file: string): PunchRecord[] {
  if (!existsSync(file)) return [];
  const rows: PunchRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(punchRecordSchema.parse(JSON.parse(line)));
    } catch {
      // A bad line stays on disk. The log is never rewritten.
    }
  }
  return rows;
}

export function appendPunchLog(file: string, record: PunchRecord) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}
