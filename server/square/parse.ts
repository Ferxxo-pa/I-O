export type SquareMoney = { amount?: number; currency?: string };

export type JobAssignment = {
  job_title?: string;
  pay_type?: string;
  hourly_rate?: SquareMoney;
  tip_eligible?: boolean;
};

export type JobWage = {
  title: string;
  hourlyCents: number;
  tipEligible: boolean;
  currency: string;
};

export type WageSetting = {
  job_assignments?: JobAssignment[];
};

export type InvoiceSnapshot = {
  id: string;
  status: string;
  title?: string;
  centsPaid: number;
  sent: boolean;
  collected: boolean;
  updatedAt?: string;
  /** Balance still due, in cents. Absent on older snapshots. */
  dueCents?: number;
  teamMemberId?: string | null;
  /** When Square took the payment. The week bar uses this, not when we saw it. */
  paidAt?: string;
  /** Real materials for this job, in cents. Absent means use the materials percent. */
  materialsCents?: number | null;
};

const SENT = new Set([
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

function positive(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0;
}

function primaryJob(wage: WageSetting | null | undefined): JobAssignment | undefined {
  const jobs = wage?.job_assignments ?? [];
  const hourly = jobs.find(
    (job) => job.pay_type === "HOURLY" && positive(job.hourly_rate?.amount),
  );
  return hourly ?? jobs.find((job) => positive(job.hourly_rate?.amount));
}

/** Primary hourly wage in cents. Prefers an HOURLY job, then any job's hourly rate. */
export function hourlyRateCents(wage: WageSetting | null | undefined): number | null {
  const amount = primaryJob(wage)?.hourly_rate?.amount;
  return positive(amount) ? amount : null;
}

/** Job title, rate, and tip flag Square needs on a timecard so labor cost is recorded. */
export function primaryJobWage(wage: WageSetting | null | undefined): JobWage | null {
  const job = primaryJob(wage);
  const amount = job?.hourly_rate?.amount;
  if (!positive(amount)) return null;
  const title = job?.job_title?.trim();
  return {
    title: title || "Hourly",
    hourlyCents: amount,
    tipEligible: Boolean(job?.tip_eligible),
    currency: job?.hourly_rate?.currency || "USD",
  };
}

export function snapshotFromInvoice(invoice: unknown): InvoiceSnapshot | null {
  if (!invoice || typeof invoice !== "object") return null;
  const row = invoice as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;

  const status = typeof row.status === "string" ? row.status : "";
  const requests = Array.isArray(row.payment_requests) ? row.payment_requests : [];
  let centsPaid = 0;
  for (const request of requests) {
    if (!request || typeof request !== "object") continue;
    const money = (request as { total_completed_amount_money?: SquareMoney })
      .total_completed_amount_money;
    if (positive(money?.amount)) centsPaid += money.amount;
  }

  const title = typeof row.title === "string" ? row.title.trim() : "";
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : undefined;
  let paidAt = "";
  for (const request of requests) {
    if (!request || typeof request !== "object") continue;
    const paid = (request as { paid_at?: unknown }).paid_at;
    if (typeof paid === "string" && paid > paidAt) paidAt = paid;
  }
  const member = row.team_member_id ?? row.employee_id;
  let dueCents = 0;
  for (const request of requests) {
    if (!request || typeof request !== "object") continue;
    const bill = request as {
      computed_amount_money?: SquareMoney;
      requested_money?: SquareMoney;
      total_completed_amount_money?: SquareMoney;
    };
    const asked = bill.computed_amount_money?.amount ?? bill.requested_money?.amount;
    const paid = bill.total_completed_amount_money?.amount ?? 0;
    if (positive(asked)) dueCents += Math.max(0, asked - (positive(paid) ? paid : 0));
  }

  return {
    id: row.id,
    status,
    title: title || undefined,
    centsPaid,
    sent: SENT.has(status),
    collected: status === "PAID" && centsPaid > 0,
    updatedAt,
    dueCents,
    teamMemberId: typeof member === "string" && member ? member : null,
    paidAt: paidAt || updatedAt,
    materialsCents: jobMaterials(row),
  };
}

function jobMaterials(row: Record<string, unknown>): number | null {
  if (typeof row.materials_cents === "number" && Number.isFinite(row.materials_cents) && row.materials_cents >= 0) {
    return Math.round(row.materials_cents);
  }
  const items = Array.isArray(row.line_items) ? row.line_items : [];
  let sum = 0;
  let found = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const named = item as { name?: unknown; description?: unknown; total_money?: SquareMoney; base_price_money?: SquareMoney };
    const name = `${typeof named.name === "string" ? named.name : ""} ${typeof named.description === "string" ? named.description : ""}`;
    if (!/material/i.test(name)) continue;
    const amount = named.total_money?.amount ?? named.base_price_money?.amount;
    if (positive(amount)) {
      sum += amount;
      found = true;
    }
  }
  return found ? sum : null;
}

export function snapshotFromWebhook(body: unknown): InvoiceSnapshot | null {
  if (!body || typeof body !== "object") return null;
  const type = (body as { type?: unknown }).type;
  if (
    type !== "invoice.payment_made" &&
    type !== "invoice.published" &&
    type !== "invoice.updated"
  ) {
    return null;
  }
  const invoice = (
    body as { data?: { object?: { invoice?: unknown } } }
  ).data?.object?.invoice;
  return snapshotFromInvoice(invoice);
}
