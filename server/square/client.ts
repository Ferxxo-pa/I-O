const SQUARE_VERSION = "2026-09-16";

export function squareConfigured(): boolean {
  return Boolean(process.env.SQUARE_ACCESS_TOKEN);
}

export function squareBaseUrl(): string {
  return process.env.SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

export async function squareFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("Square is not configured");

  const res = await fetch(`${squareBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = (await res.json().catch(() => ({}))) as {
    errors?: Array<{ detail?: string }>;
  };
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.detail || `Square request failed (${res.status})`);
  }
  return body as T;
}
