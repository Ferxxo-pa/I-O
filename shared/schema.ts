import { z } from "zod";

/**
 * I/O — Input vs Output.
 * I = what you put in (time, actions)
 * O = what you get out (money printed)
 */

export const clockSourceSchema = z.enum(["local", "square"]);
export type ClockSource = z.infer<typeof clockSourceSchema>;

export const printKindSchema = z.enum([
  "hour_print",
  "clock_in",
  "clock_out",
  "input",
  "sale",
]);
export type PrintKind = z.infer<typeof printKindSchema>;

/** Manual inputs you inject into the book. */
export const inputTypeSchema = z.enum(["prompt", "email", "message"]);
export type InputType = z.infer<typeof inputTypeSchema>;

export const INPUT_WEIGHTS: Record<
  InputType,
  { units: number; label: string }
> = {
  prompt: { units: 3, label: "PROMPT" },
  email: { units: 2, label: "EMAIL" },
  message: { units: 1, label: "MESSAGE" },
};

export const printEventSchema = z.object({
  id: z.string(),
  kind: printKindSchema,
  /** Output delta in cents (money printed). */
  outputCents: z.number().int(),
  /** Input units added (effort / actions). */
  inputUnits: z.number().int(),
  label: z.string(),
  createdAt: z.number(),
  inputType: inputTypeSchema.optional(),
});
export type PrintEvent = z.infer<typeof printEventSchema>;

export const configSchema = z.object({
  /** Output print per completed hour segment. Default $20. */
  hourlyOutputCents: z.number().int().positive().default(2000),
  /** Length of one paid hour in ms. A real hour is 3_600_000. */
  hourDurationMs: z.number().int().positive().default(3_600_000),
  clockSource: clockSourceSchema.default("local"),
});
export type AppConfig = z.infer<typeof configSchema>;

export const sessionSchema = z.object({
  clockedIn: z.boolean(),
  clockedInAt: z.number().nullable(),
  hourSegmentStartedAt: z.number().nullable(),
  /** Lifetime output printed (cents). The paycheck. */
  outputCents: z.number().int(),
  /** Square invoices collected for the company. Money in. */
  collectedCents: z.number().int().default(0),
  /** Lifetime input units (actions + optional later weights). */
  inputUnits: z.number().int(),
  /** Completed hour prints this session. */
  hoursPrinted: z.number().int(),
  externalShiftId: z.string().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const squareLinkSchema = z.object({
  connected: z.boolean(),
  source: z.enum(["square", "demo"]),
});
export type SquareLink = z.infer<typeof squareLinkSchema>;

/** One person's open or closed shift. Wages from every shift add into the company total. */
export const personShiftSchema = z.object({
  personId: z.string(),
  name: z.string(),
  hourlyCents: z.number().int().positive(),
  clockedIn: z.boolean(),
  clockedInAt: z.number().nullable(),
  hourSegmentStartedAt: z.number().nullable(),
  outputCents: z.number().int().default(0),
  timecardId: z.string().nullable().default(null),
});
export type PersonShift = z.infer<typeof personShiftSchema>;

export const viewerSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  clockedIn: z.boolean(),
});
export type Viewer = z.infer<typeof viewerSchema>;

export const appStateSchema = z.object({
  config: configSchema,
  square: squareLinkSchema,
  session: sessionSchema,
  events: z.array(printEventSchema),
  /** Unrealized output accrued across every open shift. */
  accruedOutputCents: z.number().int(),
  /** Ms of input time in the open shift (0 if idle). */
  inputMs: z.number().int(),
  msToNextPrint: z.number().int(),
  serverNow: z.number(),
  /** The person this browser is linked to. The strip greys from their clock, not the company's. */
  you: viewerSchema,
});
export type AppState = z.infer<typeof appStateSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  hourlyOutputCents: 2000,
  hourDurationMs: 3_600_000,
  clockSource: "local",
};

export const boardPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  points: z.number().int(),
  madeCents: z.number().int(),
  /** What this person earns per hour, in cents. Square replaces this when connected. */
  hourlyCents: z.number().int().positive().default(2000),
});
export type BoardPerson = z.infer<typeof boardPersonSchema>;

export const companyStateSchema = z.object({
  name: z.string().nullable(),
  code: z.string().nullable(),
  people: z.array(boardPersonSchema),
});
export type CompanyState = z.infer<typeof companyStateSchema>;

export const DEFAULT_SESSION: Session = {
  clockedIn: false,
  clockedInAt: null,
  hourSegmentStartedAt: null,
  outputCents: 0,
  collectedCents: 0,
  inputUnits: 0,
  hoursPrinted: 0,
  externalShiftId: null,
};
