export type SquareMoney = { amount?: number; currency?: string };

export type JobAssignment = {
  pay_type?: string;
  hourly_rate?: SquareMoney;
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

/** Primary hourly wage in cents. Prefers an HOURLY job, then any job's hourly rate. */
export function hourlyRateCents(wage: WageSetting | null | undefined): number | null {
  const jobs = wage?.job_assignments ?? [];
  const hourly = jobs.find(
    (job) => job.pay_type === "HOURLY" && positive(job.hourly_rate?.amount),
  );
  const fallback = jobs.find((job) => positive(job.hourly_rate?.amount));
  const amount = (hourly ?? fallback)?.hourly_rate?.amount;
  return positive(amount) ? amount : null;
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

  return {
    id: row.id,
    status,
    title: title || undefined,
    centsPaid,
    sent: SENT.has(status),
    collected: status === "PAID" && centsPaid > 0,
    updatedAt,
  };
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
