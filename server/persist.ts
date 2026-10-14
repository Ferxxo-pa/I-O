import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  companyStateSchema,
  configSchema,
  personShiftSchema,
  sessionSchema,
  squareLinkSchema,
  type CompanyState,
} from "@shared/schema";
import { fightSettingsSchema } from "@shared/fight";
import { DEFAULT_LEVEL_RULES, levelRulesSchema } from "@shared/ops";
import { pinShape } from "./auth/pin";
import { earnEngine } from "./clock/engine";
import { ensureScope, getCompany, getOwnerKey, hydrateCompany, setCompanyListener } from "./company";
import { fightBook } from "./fight/book";
import { log } from "./vite";

const fileSchema = z.object({
  version: z.literal(1),
  config: configSchema,
  session: sessionSchema,
  shifts: z.array(personShiftSchema).default([]),
  seen: z.array(z.string()).max(5000).default([]),
  squareBootstrapped: z.boolean().default(false),
  rateSource: z.enum(["default", "manual", "square"]).default("default"),
  square: squareLinkSchema,
  company: companyStateSchema,
  ownerKey: z.string().nullable().default(null),
  fight: z
    .object({
      settings: fightSettingsSchema,
      pinHash: z.string().max(200).nullable().default(null),
      streak: z.number().int().min(0).max(100_000).default(0),
      lastResolvedDate: z.string().nullable().default(null),
      todayCounted: z.boolean().default(false),
      anchorDate: z.string().nullable().default(null),
      collectedAnchor: z.number().int().nonnegative().default(0),
      wageAnchor: z.number().int().nonnegative().default(0),
      sales: z.array(z.number().int().nonnegative()).max(500).default([]),
      hours: z
        .array(
          z.object({
            personId: z.string().max(80),
            name: z.string().max(80),
            ms: z.number().int().nonnegative(),
          }),
        )
        .max(80)
        .default([]),
      level: z.number().int().min(0).max(1_000).default(0),
      consecutiveClears: z.number().int().min(0).max(100_000).default(0),
      levelNotedDate: z.string().nullable().default(null),
      levelRules: levelRulesSchema.default(DEFAULT_LEVEL_RULES),
      history: z
        .array(
          z.object({
            at: z.number(),
            date: z.string(),
            fromLevel: z.number().int(),
            toLevel: z.number().int(),
            reason: z.string().max(120),
            companyId: z.string().max(80),
            locationId: z.string().max(80),
          }),
        )
        .max(200)
        .default([]),
      days: z
        .array(
          z.object({
            companyId: z.string().max(80),
            locationId: z.string().max(80),
            date: z.string(),
            collectedCents: z.number().int().nonnegative(),
            wageCents: z.number().int().nonnegative(),
            breakEvenCents: z.number().int().nonnegative(),
            potCents: z.number().int().nonnegative(),
            payoutPotCents: z.number().int().nonnegative(),
            cleared: z.boolean(),
            hours: z
              .array(
                z.object({
                  personId: z.string().max(80),
                  name: z.string().max(80),
                  ms: z.number().int().nonnegative(),
                }),
              )
              .max(80),
          }),
        )
        .max(400)
        .default([]),
      payouts: z
        .array(
          z.object({
            companyId: z.string().max(80),
            locationId: z.string().max(80),
            weekStart: z.string(),
            potCents: z.number().int().nonnegative(),
            shares: z
              .array(
                z.object({
                  id: z.string().max(80),
                  name: z.string().max(80),
                  cents: z.number().int().nonnegative(),
                  ms: z.number().int().nonnegative(),
                }),
              )
              .max(80),
            status: z.enum(["open", "paid"]),
            approvedAt: z.number().int().nullable(),
          }),
        )
        .max(120)
        .default([]),
      resolvedWeeks: z.array(z.string().max(200)).max(200).default([]),
      lastResolvedWeek: z.string().nullable().default(null),
      lastWeekScope: z.string().nullable().default(null),
      weekStreak: z.number().int().min(0).max(100_000).default(0),
      webhookSeenAt: z.number().int().nullable().default(null),
    })
    .optional(),
});

export function parseSavedState(raw: unknown) {
  return fileSchema.parse(raw);
}

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
  fightBook.setListener(scheduleSave);
  setCompanyListener(scheduleSave);
  ensureScope(process.env.SQUARE_LOCATION_ID ?? null, fightBook.scopeHint());
  bootstrapShopPin();
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
      shifts: parsed.shifts,
      seen: parsed.seen,
      squareBootstrapped: parsed.squareBootstrapped,
      rateSource: parsed.rateSource,
      square: parsed.square,
    });
    hydrateCompany(parsed.company, parsed.ownerKey);
    fightBook.hydrate(parsed.fight ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unreadable state";
    log(`keeping a fresh book, saved state was unreadable: ${message}`, "store");
  }
}

function bootstrapShopPin() {
  const raw = process.env.SHOP_PIN?.trim() ?? "";
  if (!raw || fightBook.pinSet()) return;
  if (!pinShape(raw)) {
    log("SHOP_PIN must be 4 to 8 digits", "auth");
    return;
  }
  fightBook.setPin(raw);
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
        ownerKey: getOwnerKey(),
        fight: fightBook.toPersist(),
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
