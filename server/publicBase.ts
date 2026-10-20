/** Public https origin. PUBLIC_BASE_URL wins. PRESENCE_PUBLIC_URL still works. */
export function publicBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL?.trim() || process.env.PRESENCE_PUBLIC_URL?.trim() || "";
  return raw.replace(/\/+$/, "");
}

/** Square signs this exact URL. An explicit webhook URL wins over the public origin. */
export function webhookNotificationUrl(): string {
  const explicit = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL?.trim() || "";
  if (explicit) return explicit;
  const base = publicBaseUrl();
  return base ? `${base}/api/square/webhook` : "";
}
