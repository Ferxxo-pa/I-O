const TTL_MS = 60_000;
const TIMEOUT_MS = 2_500;

let cached: { at: number; ok: boolean; detail: string; note?: string } | null = null;

export function resetPublicUrlCache() {
  cached = null;
}

/** Ask the public host for the cheap probe so this check cannot call itself. */
export async function publicUrlCheck(now = Date.now()): Promise<{ ok: boolean; detail: string; note?: string }> {
  const url = process.env.PRESENCE_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  if (!url) return { ok: false, detail: "Set PRESENCE_PUBLIC_URL" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, detail: "Use https://" };
  }
  if (parsed.protocol !== "https:") return { ok: false, detail: "Use https://" };
  if (cached && now - cached.at < TTL_MS) return { ok: cached.ok, detail: cached.detail, note: cached.note };
  const note = parsed.host;
  try {
    const res = await fetch(`${url}/api/health?probe=1`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json().catch(() => ({}))) as { ok?: unknown };
    const ok = res.ok && body.ok === true;
    cached = { at: now, ok, detail: ok ? note : "Not reachable", note: ok ? note : undefined };
  } catch {
    cached = { at: now, ok: false, detail: "Not reachable" };
  }
  return { ok: cached.ok, detail: cached.detail, note: cached.note };
}
