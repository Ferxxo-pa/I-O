import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  companyStateSchema,
  configSchema,
  sessionSchema,
  squareLinkSchema,
  type CompanyState,
} from "@shared/schema";
import { earnEngine } from "./clock/engine";
import { getCompany, hydrateCompany, setCompanyListener } from "./company";
import { log } from "./vite";

const fileSchema = z.object({
  version: z.literal(1),
  config: configSchema,
  session: sessionSchema,
  seen: z.array(z.string()).max(5000).default([]),
  squareBootstrapped: z.boolean().default(false),
  rateSource: z.enum(["default", "manual", "square"]).default("default"),
  square: squareLinkSchema,
  company: companyStateSchema,
});

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function statePath(): string {
  const dir = process.env.DATA_DIR || join(process.cwd(), "data");
  return join(dir, "io-state.json");
}

export function startPersistence() {
  if (started) return;
  started = true;
  loadState();
  earnEngine.setBookListener(scheduleSave);
  setCompanyListener(scheduleSave);
  applyHourOverride();
}

export function flushState() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  writeState();
}

function scheduleSave() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    writeState();
  }, 100);
}

export function loadState() {
  const path = statePath();
  if (!existsSync(path)) return;
  try {
    const parsed = fileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    earnEngine.hydrate({
      config: parsed.config,
      session: parsed.session,
      seen: parsed.seen,
      squareBootstrapped: parsed.squareBootstrapped,
      rateSource: parsed.rateSource,
      square: parsed.square,
    });
    hydrateCompany(parsed.company);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unreadable state";
    log(`keeping a fresh book, saved state was unreadable: ${message}`, "store");
  }
}

function applyHourOverride() {
  const raw = process.env.HOUR_DURATION_MS;
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) return;
  earnEngine.setConfig({ hourDurationMs: ms });
}

function writeState() {
  try {
    const path = statePath();
    const body = JSON.stringify(
      {
        version: 1 as const,
        ...earnEngine.toPersist(),
        company: getCompany() satisfies CompanyState,
      },
      null,
      2,
    );
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not save";
    log(`state was not saved: ${message}`, "store");
  }
}
