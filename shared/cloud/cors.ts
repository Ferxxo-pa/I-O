/** The hosted app answers only its own browser origin. Phones omit Origin and still pass. */

export function originAllowed(origin: string | null, allowed: readonly string[] | "*"): boolean {
  if (!origin) return true;
  if (allowed === "*") return true;
  return allowed.includes(origin);
}

export const CORS_HEADERS = "authorization, content-type, x-desk-token, x-owner-key, x-person-id, x-shop-pin, x-company-id";

export function corsHeaders(origin: string | null, selfOrigin: string): Headers {
  const headers = new Headers();
  if (origin && originAllowed(origin, [selfOrigin])) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
    headers.set("access-control-allow-headers", CORS_HEADERS);
    headers.set("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    headers.set("access-control-max-age", "600");
  }
  return headers;
}
