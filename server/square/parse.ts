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
  feeCents: number;
  refundedCents: number;
  /** Gross collected, minus fees once, minus refunds. Negative means the fee outlived the refund. */
  netCents: number;
  sent: boolean;
  collected: boolean;
  updatedAt?: string;
};

export type SquareNet = {
  sourceId: string;
  grossCents: number;
  feeCents: number;
  refundedCents: number;
  netCents: number;
  at?: string;
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

function centsOf(money: SquareMoney | undefined): number {
  return positive(money?.amount) ? money.amount : 0;
}

/** Sum processing fees on one payment. The array wins, so a summary field is not added again. */
export function feeCentsOf(row: Record<string, unknown>): number {
  const list = row.processing_fee;
  if (Array.isArray(list)) {
    let total = 0;
    for (const fee of list) {
      if (!fee || typeof fee !== "object") continue;
      total += centsOf((fee as { amount_money?: SquareMoney }).amount_money);
    }
    return total;
  }
  return centsOf(row.processing_fee_money as SquareMoney | undefined);
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
  const feeCents = feeCentsOf(row);
  let refundedCents = centsOf(row.refunded_money as SquareMoney | undefined);
  if (refundedCents === 0 && status === "REFUNDED") refundedCents = centsPaid;
  const netCents = centsPaid - feeCents - refundedCents;

  return {
    id: row.id,
    status,
    title: title || undefined,
    centsPaid,
    feeCents,
    refundedCents,
    netCents,
    sent: SENT.has(status),
    collected: status === "PAID" && centsPaid > 0,
    updatedAt,
  };
}

export function netFromPayment(payment: unknown): SquareNet | null {
  if (!payment || typeof payment !== "object") return null;
  const row = payment as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  const status = typeof row.status === "string" ? row.status : "";
  if (status !== "COMPLETED" && status !== "REFUNDED") return null;
  const grossCents = centsOf(row.amount_money as SquareMoney | undefined);
  const feeCents = feeCentsOf(row);
  let refundedCents = centsOf(row.refunded_money as SquareMoney | undefined);
  if (refundedCents === 0 && status === "REFUNDED") refundedCents = grossCents;
  const invoiceId = typeof row.invoice_id === "string" && row.invoice_id ? row.invoice_id : "";
  const at =
    (typeof row.updated_at === "string" && row.updated_at) ||
    (typeof row.created_at === "string" && row.created_at) ||
    undefined;
  return {
    sourceId: `square:${invoiceId || row.id}`,
    grossCents,
    feeCents,
    refundedCents,
    netCents: grossCents - feeCents - refundedCents,
    at,
  };
}

export function netFromWebhook(body: unknown): SquareNet | null {
  if (!body || typeof body !== "object") return null;
  const type = (body as { type?: unknown }).type;
  if (type === "payment.created" || type === "payment.updated") {
    const payment = (body as { data?: { object?: { payment?: unknown } } }).data?.object?.payment;
    return netFromPayment(payment);
  }
  const snapshot = snapshotFromWebhook(body);
  if (!snapshot) return null;
  if (!snapshot.collected && snapshot.refundedCents <= 0 && snapshot.netCents === 0) return null;
  return {
    sourceId: `square:${snapshot.id}`,
    grossCents: snapshot.centsPaid,
    feeCents: snapshot.feeCents,
    refundedCents: snapshot.refundedCents,
    netCents: snapshot.netCents,
    at: snapshot.updatedAt,
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
