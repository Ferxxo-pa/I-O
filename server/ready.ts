import { ownLoginPct, readiness, type ReadinessCheck } from "@shared/ops";
import { backupCheck } from "./backup";
import { ioMode, lanBaseUrl, relayConfigured } from "./mode";
import { webhookNotificationUrl } from "./publicBase";
import { earnEngine } from "./clock/engine";
import { currentScope, getCompany } from "./company";
import { fightBook } from "./fight/book";
import { publicUrlCheck } from "./publicUrl";
import { squareConfigured } from "./square/client";

export type HealthReport = {
  ok: true;
  ready: boolean;
  scope: { companyId: string; locationId: string };
  checks: ReadinessCheck[];
};

/** Process is up when `ok` is true. `ready` is the go-live checklist. */
export async function healthReport(): Promise<HealthReport> {
  const signals = fightBook.signals();
  const people = getCompany().people;
  const roster = people.length;
  const rated = people.filter((person) => person.hourlyCents > 0).length;
  const linkedIds = new Set(earnEngine.linkedPersonIds());
  const linked = people.filter((person) => linkedIds.has(person.id)).length;
  const pct = ownLoginPct(roster, linked);
  const ownLoginDetail = pct == null ? "Add the team" : `${linked} of ${roster} · ${pct}%`;

  const square = squareConfigured();
  const ratesOk = square
    ? earnEngine.rateSourceName() === "square" || (roster > 0 && rated === roster)
    : roster > 0 && rated === roster;
  const rateDetail = square && earnEngine.rateSourceName() === "square"
    ? "Square"
    : roster === 0
      ? "Add the team"
      : `${rated} of ${roster}`;

  const backup = backupCheck();
  const local = ioMode() === "local-relay";
  const webhookConfigured = local || Boolean(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY && webhookNotificationUrl());
  const publicUrl = local ? null : await publicUrlCheck();
  let lanNote = "";
  try {
    lanNote = new URL(lanBaseUrl()).host;
  } catch {
    lanNote = lanBaseUrl();
  }
  const report = readiness({
    squareToken: square,
    webhookConfigured,
    webhookSeen: local || signals.webhookSeen,
    pinSet: signals.pinSet,
    rentEntered: signals.rentEntered,
    ratesOk,
    rateDetail,
    ownLoginPct: pct,
    ownLoginDetail,
    backupOk: backup.ok,
    backupDetail: backup.detail,
    backupNote: backup.note,
    webhookNote: local ? "Square is polled. Webhooks are off." : undefined,
    publicUrlOk: local ? relayConfigured() : publicUrl?.ok,
    publicUrlLabel: local ? "Shop LAN" : undefined,
    publicUrlDetail: local
      ? relayConfigured()
        ? lanBaseUrl()
        : "Set RELAY_PUBLIC_URL, RELAY_SHOP_SECRET, and RELAY_SEAL_KEY"
      : publicUrl?.detail,
    publicUrlNote: local ? (relayConfigured() ? lanNote : undefined) : publicUrl?.note,
  });
  return { ok: true, ready: report.ready, scope: currentScope(), checks: report.checks };
}
