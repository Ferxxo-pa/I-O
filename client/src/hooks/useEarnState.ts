import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, PrintEvent } from "@shared/schema";
import { apiUrl } from "@/serverUrl";

export const WHO_ID = "io.who";
export const PIN_KEY = "io.shop.pin";
export const OWNER_KEY = "io.owner";

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const who = localStorage.getItem(WHO_ID);
  if (who) headers["x-person-id"] = who;
  const pin = sessionStorage.getItem(PIN_KEY);
  if (pin) headers["x-shop-pin"] = pin;
  const owner = localStorage.getItem(OWNER_KEY);
  if (owner) headers["x-owner-key"] = owner;
  return headers;
}

export function shopPin(): string | null {
  return sessionStorage.getItem(PIN_KEY);
}

export function setShopPin(pin: string) {
  sessionStorage.setItem(PIN_KEY, pin);
}

export function clearShopPin() {
  sessionStorage.removeItem(PIN_KEY);
}

function personHeaders(): Record<string, string> {
  return authHeaders();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { ...personHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function useIoState() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const [freshEvents, setFreshEvents] = useState<PrintEvent[]>([]);

  const ingest = useCallback((next: AppState, seedOnly = false) => {
    setState(next);
    if (!seeded.current) {
      next.events.forEach((e) => seenIds.current.add(e.id));
      seeded.current = true;
      return;
    }
    const brandNew = next.events.filter((e) => !seenIds.current.has(e.id));
    brandNew.forEach((e) => seenIds.current.add(e.id));
    if (seedOnly) return;
    const hits = brandNew.filter(
      (e) => e.kind === "hour_print" || e.kind === "sale" || e.kind === "input",
    );
    if (hits.length) {
      setFreshEvents((prev) => [...hits, ...prev].slice(0, 8));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api<AppState>("/api/state");
      ingest(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Offline");
    }
  }, [ingest]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("demo")) return;
    let stop = false;
    let timer = 0;
    let delay = 1000;
    let controller: AbortController | null = null;
    const connect = async () => {
      controller = new AbortController();
      try {
        const res = await fetch(apiUrl("/api/live"), {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(res.status === 401 ? "Shop PIN required" : "Offline");
        delay = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          let cut = buf.indexOf("\n\n");
          while (cut >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const line = block.split("\n").find((row) => row.startsWith("data: "));
            if (line) {
              ingest(JSON.parse(line.slice(6)) as AppState);
              setError(null);
            }
            cut = buf.indexOf("\n\n");
          }
        }
        throw new Error("Offline");
      } catch (err) {
        if (stop || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error && err.message ? err.message : "Offline");
      }
      if (stop) return;
      timer = window.setTimeout(() => {
        void connect();
      }, delay);
      delay = Math.min(delay * 2, 15_000);
    };
    void connect();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [ingest]);

  const run = useCallback(
    async (fn: () => Promise<AppState>) => {
      setPending(true);
      try {
        ingest(await fn());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setPending(false);
      }
    },
    [ingest],
  );

  const clockIn = () => {
    const personId = localStorage.getItem(WHO_ID);
    return run(() =>
      api("/api/clock/in", { method: "POST", body: JSON.stringify({ personId }) }),
    );
  };
  const clockOut = () => {
    const personId = localStorage.getItem(WHO_ID);
    return run(() =>
      api("/api/clock/out", { method: "POST", body: JSON.stringify({ personId }) }),
    );
  };
  const recordInput = (type: "prompt" | "email") =>
    run(() => api(`/api/input/${type}`, { method: "POST" }));
  const reset = () =>
    run(() => {
      seenIds.current = new Set();
      seeded.current = false;
      setFreshEvents([]);
      return api("/api/reset", { method: "POST" });
    });

  const dismissTick = useCallback((id: string) => {
    setFreshEvents((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return {
    state,
    error,
    pending,
    freshEvents,
    dismissTick,
    refresh,
    clockIn,
    clockOut,
    recordInput,
    reset,
  };
}
