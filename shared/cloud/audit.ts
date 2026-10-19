/** Audit rows name the action and the role. They do not name a person, a token, or a wage. */

export type AuditActor = "owner" | "pin" | "phone" | "square" | "cron" | "anon";

export type AuditRow = {
  id: string;
  companyId: string | null;
  at: number;
  action: string;
  actor: AuditActor;
  ok: boolean;
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /Bearer\s+\S+/gi;
const LONG = /\b[A-Za-z0-9_-]{24,}\b/g;

export function auditRow(input: Omit<AuditRow, "id"> & { id?: string }): AuditRow {
  return {
    id: input.id ?? `${input.at}-${input.action}`,
    companyId: input.companyId,
    at: input.at,
    action: input.action.slice(0, 64),
    actor: input.actor,
    ok: input.ok,
  };
}

/** Strip addresses, bearer tokens, and long secrets before anything is logged. */
export function redactLog(message: string): string {
  return message.replace(EMAIL, "[email]").replace(BEARER, "Bearer [redacted]").replace(LONG, "[id]");
}
