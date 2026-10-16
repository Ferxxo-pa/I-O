import { useCallback, useEffect, useState, type FormEvent } from "react";
import { WHO_ID } from "@/hooks/useEarnState";
import { formatDistance, type PunchAction, type PunchReason } from "@shared/punch";

const PIN_KEY = "io.shop.pin";
const WHO_NAME = "io.who.name";
const OWNER_STORE = "io.owner";

type Person = { id: string; name: string };
type You = { id: string; name: string; clockedIn: boolean; clockedInAt: number | null };
type Shop = { label: string; address: string; radiusM: number };
type Session = { shop: Shop; mode: "local" | "square"; people: Person[]; you: You | null };
type Locate = { inside: boolean; distanceM: number; reason: PunchReason | null; message: string | null };
type PunchResult = {
  accepted: boolean;
  reason: PunchReason | null;
  message: string | null;
  distanceM: number;
  action: PunchAction;
  at: number;
  you: You;
};
type PunchRow = {
  id: string;
  personName: string;
  action: PunchAction;
  at: number;
  distanceM: number;
  accepted: boolean;
  message: string | null;
};

type Fix = { lat: number; lng: number; accuracyM: number; capturedAt: number };

function headers(): Record<string, string> {
  const next: Record<string, string> = { "Content-Type": "application/json" };
  const pin = sessionStorage.getItem(PIN_KEY);
  const who = localStorage.getItem(WHO_ID);
  const owner = localStorage.getItem(OWNER_STORE);
  if (pin) next["x-shop-pin"] = pin;
  if (who) next["x-person-id"] = who;
  if (owner) next["x-owner-key"] = owner;
  return next;
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  return res.json().catch(() => ({}));
}

function readFix(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser has no location"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          capturedAt: position.timestamp,
        }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) reject(new Error("Allow location to clock in"));
        else if (err.code === err.TIMEOUT) reject(new Error("Location timed out"));
        else reject(new Error("Location is unavailable"));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
    );
  });
}

function when(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function PunchPage() {
  const [phase, setPhase] = useState<"boot" | "pin" | "who" | "clock">("boot");
  const [pin, setPin] = useState("");
  const [shop, setShop] = useState<Shop>({ label: "EZ Designs", address: "403 E Ben White Blvd, Austin, TX", radiusM: 120 });
  const [mode, setMode] = useState<"local" | "square">("local");
  const [people, setPeople] = useState<Person[]>([]);
  const [you, setYou] = useState<You | null>(null);
  const [locate, setLocate] = useState<Locate | null>(null);
  const [last, setLast] = useState<PunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needsPin, setNeedsPin] = useState(false);
  const [logOpen, setLogOpen] = useState(() => window.location.pathname.startsWith("/punch/log"));
  const [punches, setPunches] = useState<PunchRow[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [ownerDraft, setOwnerDraft] = useState("");

  const applySession = useCallback((body: Session) => {
    setShop(body.shop);
    setMode(body.mode);
    setPeople(body.people);
    setYou(body.you);
    if (!body.you) {
      localStorage.removeItem(WHO_ID);
      localStorage.removeItem(WHO_NAME);
      setPhase("who");
      return;
    }
    localStorage.setItem(WHO_NAME, body.you.name);
    setPhase("clock");
  }, []);

  const loadSession = useCallback(async () => {
    const res = await fetch("/api/punch/session", { headers: headers() });
    const body = (await readBody(res)) as Session & { message?: string };
    if (res.status === 403) {
      setNeedsPin(true);
      setPhase("pin");
      setError(body.message || "Set a shop PIN");
      return;
    }
    if (!res.ok) {
      sessionStorage.removeItem(PIN_KEY);
      setPhase("pin");
      if (res.status !== 401) setError(body.message || "Couldn't open the clock");
      return;
    }
    setNeedsPin(false);
    setError(null);
    applySession(body);
  }, [applySession]);

  useEffect(() => {
    document.title = "Clock · EZ Designs";
    if (!sessionStorage.getItem(PIN_KEY)) {
      setPhase("pin");
      return;
    }
    void loadSession();
  }, [loadSession]);

  const refreshLocation = useCallback(async () => {
    setError(null);
    try {
      const fix = await readFix();
      const res = await fetch("/api/punch/locate", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ fix }),
      });
      const body = (await readBody(res)) as Locate & { message?: string };
      if (!res.ok) throw new Error(body.message || "Couldn't check that location");
      setLocate(body);
    } catch (err) {
      setLocate(null);
      setError(err instanceof Error ? err.message : "Couldn't check that location");
    }
  }, []);

  useEffect(() => {
    if (phase !== "clock") return;
    void refreshLocation();
  }, [phase, you?.id, refreshLocation]);

  const loadLog = useCallback(async () => {
    const res = await fetch("/api/punches", { headers: headers() });
    const body = (await readBody(res)) as { punches?: PunchRow[]; message?: string; mode?: "local" | "square" };
    if (!res.ok) {
      setPunches(null);
      setLogError(body.message || "Couldn't load punches");
      return;
    }
    setLogError(null);
    if (body.mode) setMode(body.mode);
    setPunches(body.punches ?? []);
  }, []);

  useEffect(() => {
    if (!logOpen) return;
    void loadLog();
  }, [logOpen, loadLog, last]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/punch/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = (await readBody(res)) as { message?: string };
      if (!res.ok) {
        if (res.status === 403) setNeedsPin(true);
        throw new Error(body.message || "Wrong PIN");
      }
      sessionStorage.setItem(PIN_KEY, pin);
      setPin("");
      await loadSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wrong PIN");
    } finally {
      setPending(false);
    }
  };

  const savePin = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/punch/pin", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ pin }),
      });
      const body = (await readBody(res)) as { message?: string };
      if (!res.ok) throw new Error(body.message || "Couldn't set the PIN");
      sessionStorage.setItem(PIN_KEY, pin);
      setPin("");
      setNeedsPin(false);
      await loadSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set the PIN");
    } finally {
      setPending(false);
    }
  };

  const choose = (person: Person) => {
    localStorage.setItem(WHO_ID, person.id);
    localStorage.setItem(WHO_NAME, person.name);
    setYou({ id: person.id, name: person.name, clockedIn: false, clockedInAt: null });
    setLast(null);
    setLocate(null);
    setPhase("clock");
    void loadSession();
  };

  const punch = async () => {
    if (!you) return;
    const action: PunchAction = you.clockedIn ? "out" : "in";
    setPending(true);
    setError(null);
    try {
      const fix = await readFix();
      const res = await fetch("/api/punch", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ action, fix }),
      });
      const body = (await readBody(res)) as PunchResult & { message?: string };
      if (!res.ok) throw new Error(typeof body.message === "string" ? body.message : "Punch failed");
      setLast(body);
      setYou(body.you);
      setLocate({
        inside: body.accepted || body.reason === "already_clocked_in" || body.reason === "not_clocked_in",
        distanceM: body.distanceM,
        reason: body.reason,
        message: body.message,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Punch failed");
    } finally {
      setPending(false);
    }
  };

  const lock = () => {
    sessionStorage.removeItem(PIN_KEY);
    setPhase("pin");
    setYou(null);
    setLast(null);
    setLocate(null);
    setError(null);
    setLogOpen(false);
  };

  const dataState = cardState(phase, you, locate, last);
  const copy = statusCopy(dataState, you, locate, last, error);

  return (
    <div className="punch-stage">
      <a className="punch-home" href="/">
        I/O
      </a>
      <section className="punch-card" data-state={dataState} aria-live="polite">
        <div className="punch-kicker">
          <span>{shop.label}</span>
          {phase === "clock" && (
            <button type="button" onClick={lock}>
              Lock
            </button>
          )}
        </div>
        <h1 className="punch-shop">Clock</h1>
        <p className="punch-address">{shop.address}</p>

        {phase === "pin" && (
          <form className="punch-form" onSubmit={needsPin && localStorage.getItem(OWNER_STORE) ? savePin : signIn}>
            <input
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Shop PIN"
              aria-label="Shop PIN"
              type="password"
              autoFocus
            />
            {error && <p className="punch-detail">{error}</p>}
            <button className="punch-go" type="submit" disabled={pending || pin.length < 4}>
              {needsPin && localStorage.getItem(OWNER_STORE) ? "Set PIN" : "Enter"}
            </button>
          </form>
        )}

        {phase === "who" && (
          <div className="punch-people">
            {people.map((person) => (
              <button key={person.id} type="button" onClick={() => choose(person)}>
                {person.name}
              </button>
            ))}
            {people.length === 0 && <p className="punch-empty">The owner adds people in Change.</p>}
            <div className="punch-tools">
              <button type="button" onClick={lock}>
                Lock
              </button>
            </div>
          </div>
        )}

        {phase === "clock" && you && (
          <>
            <p className="punch-who">{you.name}</p>
            <p className="punch-status">{copy.title}</p>
            <p className="punch-detail">{copy.detail}</p>
            <button className="punch-go" type="button" onClick={() => void punch()} disabled={pending}>
              {pending ? "Finding you" : you.clockedIn ? "Clock out" : "Clock in"}
            </button>
            <div className="punch-tools">
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem(WHO_ID);
                  setYou(null);
                  setLast(null);
                  setLocate(null);
                  setPhase("who");
                }}
              >
                Switch
              </button>
              <button type="button" onClick={() => setLogOpen((open) => !open)}>
                Log
              </button>
            </div>
          </>
        )}
      </section>

      {logOpen && (
        <section className="punch-log" aria-label="Punch log">
          <h2>Punches</h2>
          <p className="punch-mode">{mode === "square" ? "Square timecards" : "Local log"}</p>
          {logError && <p className="punch-detail">{logError}</p>}
          {logError && (
            <form
              className="punch-key"
              onSubmit={(event) => {
                event.preventDefault();
                const key = ownerDraft.trim();
                if (!key) return;
                localStorage.setItem(OWNER_STORE, key);
                setOwnerDraft("");
                void loadLog();
              }}
            >
              <input
                value={ownerDraft}
                onChange={(event) => setOwnerDraft(event.target.value)}
                placeholder="Owner key"
                aria-label="Owner key"
                autoComplete="off"
              />
            </form>
          )}
          {punches && punches.length === 0 && <p className="punch-empty">No punches yet</p>}
          {punches && punches.length > 0 && (
            <>
              <div className="punch-log-head">
                <span>Who</span>
                <span>Punch</span>
                <span>Time</span>
                <span>Distance</span>
                <span>Result</span>
              </div>
              <ul>
                {punches.map((row) => (
                  <li key={row.id}>
                    <span>{row.personName}</span>
                    <span>{row.action === "in" ? "In" : "Out"}</span>
                    <time dateTime={new Date(row.at).toISOString()}>{when(row.at)}</time>
                    <span>{formatDistance(row.distanceM)}</span>
                    <span className={row.accepted ? "ok" : "no"}>{row.accepted ? "Accepted" : row.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function cardState(
  phase: "boot" | "pin" | "who" | "clock",
  you: You | null,
  locate: Locate | null,
  last: PunchResult | null,
): string {
  if (phase === "pin" || phase === "boot") return "login";
  if (phase === "who") return "who";
  if (last && !last.accepted) return "rejected";
  if (you?.clockedIn) return "clocked-in";
  if (locate?.inside) return "inside";
  if (locate) return "outside";
  return "locating";
}

function statusCopy(
  state: string,
  you: You | null,
  locate: Locate | null,
  last: PunchResult | null,
  error: string | null,
): { title: string; detail: string } {
  if (state === "rejected" && last) {
    const distance = formatDistance(last.distanceM);
    const detail =
      last.reason === "outside_fence" || last.reason === "already_clocked_in" || last.reason === "not_clocked_in"
        ? `${distance} · Not recorded`
        : "Not recorded";
    return { title: last.message || "Not recorded", detail };
  }
  if (state === "clocked-in" && you) {
    const distance = last?.distanceM ?? locate?.distanceM;
    const bits = [you.clockedInAt ? when(you.clockedInAt) : "", distance != null ? formatDistance(distance) : ""].filter(
      Boolean,
    );
    return { title: "Clocked in", detail: bits.join(" · ") };
  }
  if (state === "inside" && locate) return { title: "Inside the shop", detail: formatDistance(locate.distanceM) };
  if (state === "outside" && locate) {
    return { title: locate.message || "Outside the shop", detail: formatDistance(locate.distanceM) };
  }
  if (error) return { title: "Location", detail: error };
  return { title: "Finding you", detail: "Checking the shop fence" };
}
