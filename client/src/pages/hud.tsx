import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useIoState } from "@/hooks/useEarnState";
import { ching, unlockChing } from "@/lib/ching";
import type { CompanyState, PrintEvent } from "@shared/schema";

type CompanyView = CompanyState & { owner?: boolean; square?: boolean; ownerKey?: string };

const OWNER_STORE = "io.owner";

function ownerHeaders(): Record<string, string> {
  const key = localStorage.getItem(OWNER_STORE);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["x-owner-key"] = key;
  return headers;
}

function money(cents: number): string {
  const n = cents / 100;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-${abs}` : abs;
}

const CHIP_COLORS = ["#f83090", "#38b8f8", "#a8c838", "#f86020", "#d888f8", "#0048c8", "#00a850"];

function threeColors(): string[] {
  const pool = [...CHIP_COLORS];
  const picked: string[] = [];
  for (let i = 0; i < 3; i++) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

function rateText(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return String(dollars);
  return dollars.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export default function Hud() {
  const { state, error, pending, freshEvents, dismissTick, clockIn, clockOut } = useIoState();
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [change, setChange] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [chips, setChips] = useState(threeColors);
  const [company, setCompany] = useState<CompanyView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const heard = useRef(new Set<string>());

  useEffect(() => {
    const unlock = () => unlockChing();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    for (const event of freshEvents) {
      if (heard.current.has(event.id)) continue;
      heard.current.add(event.id);
      if (event.kind === "sale" && event.outputCents > 0) ching();
    }
  }, [freshEvents]);

  const live = state?.session.clockedIn ?? false;
  const moneyOut = (state?.session.outputCents ?? 0) + (state?.accruedOutputCents ?? 0);
  const moneyIn = state?.session.collectedCents ?? 0;
  const points = state?.session.inputUnits ?? 0;
  const combined = moneyIn + moneyOut;
  const barFloor = 16;
  let greenShare = 0;
  let redShare = 0;
  if (combined > 0) {
    if (moneyIn === 0) {
      greenShare = barFloor;
      redShare = 100 - barFloor;
    } else if (moneyOut === 0) {
      redShare = barFloor;
      greenShare = 100 - barFloor;
    } else {
      greenShare = Math.min(100 - barFloor, Math.max(barFloor, (moneyIn / combined) * 100));
      redShare = 100 - greenShare;
    }
  }
  const wide = (menu || settings || change) && !collapsed;

  useEffect(() => {
    if (!live) return;
    setChips(threeColors());
    const id = window.setInterval(() => setChips(threeColors()), 3600);
    return () => window.clearInterval(id);
  }, [live]);

  const takeCompany = (next: CompanyView) => {
    if (next.ownerKey) localStorage.setItem(OWNER_STORE, next.ownerKey);
    setCompany(next);
  };

  useEffect(() => {
    let cancel = false;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("join");
    const load = code
      ? fetch("/api/company/join", {
          method: "POST",
          headers: ownerHeaders(),
          body: JSON.stringify({ code }),
        })
      : fetch("/api/company", { headers: ownerHeaders() });
    void load
      .then(async (res) => {
        const next = (await res.json()) as CompanyView;
        if (!res.ok) throw new Error((next as { message?: string }).message || "Couldn't load settings");
        if (cancel) return;
        takeCompany(next);
        if (code) setSettings(true);
      })
      .catch((err) => {
        if (!cancel) setSettingsError(err instanceof Error ? err.message : "Couldn't load settings");
      })
      .finally(() => {
        if (!code) return;
        params.delete("join");
        const rest = params.toString();
        window.history.replaceState({}, "", rest ? `/?${rest}` : "/");
      });
    return () => {
      cancel = true;
    };
  }, []);

  const saveCompany = async (path: string, body: unknown) => {
    setSettingsError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify(body),
    });
    const next = (await res.json()) as CompanyView & { message?: string };
    if (!res.ok) throw new Error(next.message || "Couldn't save that");
    takeCompany(next);
  };

  const toggle = () => {
    if (pending || !state) return;
    if (live) clockOut();
    else clockIn();
  };

  return (
    <div className="stage">
      <div className="strip-anchor">
        <PrintTape events={freshEvents} onDone={dismissTick} />

        <div
          className={`strip ${live ? "live" : "idle"}${collapsed ? " collapsed" : ""}${wide ? " with-panel" : ""}`}
        >
          <span className="chips" aria-hidden>
            {chips.map((color, index) => (
              <i key={index} style={live ? { background: color } : undefined} />
            ))}
          </span>
          <button
            type="button"
            className="mark"
            onClick={toggle}
            disabled={pending || !state}
            title={live ? "Clock out" : "Clock in"}
          >
            I/O
            <span className="tip">{live ? "Clock out" : "Clock in"}</span>
          </button>
          {!collapsed && (
            <span className="nums">
              <span className="num up">+${money(moneyIn)}</span>
              <span className="num down">−${money(moneyOut)}</span>
            </span>
          )}
          <span className="actions">
            {!collapsed && (
              <button type="button" className="plus" onClick={() => setMenu((open) => !open)} aria-label="More">
                +
              </button>
            )}
            <button
              type="button"
              className="fold"
              onClick={() => {
                setCollapsed((open) => !open);
                setMenu(false);
                setSettings(false);
                setChange(false);
              }}
              aria-label={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? "›" : "‹"}
            </button>
          </span>
          {!collapsed && (
            <span className="balance-bar" aria-hidden>
              {combined > 0 && (
                <>
                  <i className="in" style={{ width: `${greenShare}%` }} />
                  <i className="out" style={{ width: `${redShare}%` }} />
                </>
              )}
            </span>
          )}
        </div>

        <AnimatePresence>
          {menu && (
            <motion.div
              className="menu"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
            >
              <div className="menu-row">
                <span>Points</span>
                <span>{points}</span>
              </div>
              <div className="menu-actions">
                <button
                  type="button"
                  onClick={() => {
                    setSettings(true);
                    setChange(false);
                    setMenu(false);
                  }}
                >
                  Settings
                </button>
                {company?.owner && (
                  <button
                    type="button"
                    onClick={() => {
                      setChange(true);
                      setSettings(false);
                      setMenu(false);
                    }}
                  >
                    Change
                  </button>
                )}
              </div>
              {error && <div className="err">{error}</div>}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {settings && (
            <SettingsPanel
              company={company}
              error={settingsError}
              onClose={() => setSettings(false)}
              onSave={async (path, body) => {
                try {
                  await saveCompany(path, body);
                } catch (err) {
                  setSettingsError(err instanceof Error ? err.message : "Couldn't save that");
                  throw err;
                }
              }}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {change && <ChangePanel onClose={() => setChange(false)} onCompany={takeCompany} />}
        </AnimatePresence>
      </div>
    </div>
  );
}

function SettingsPanel({
  company,
  error,
  onClose,
  onSave,
}: {
  company: CompanyState | null;
  error: string | null;
  onClose: () => void;
  onSave: (path: string, body: unknown) => Promise<void>;
}) {
  const [mode, setMode] = useState<"join" | "create" | null>(null);
  const [draft, setDraft] = useState("");
  const invite = company?.code ? `${window.location.origin}/?join=${company.code}` : "";

  const submit = (next: "join" | "create", value: string) => {
    const save =
      next === "create"
        ? onSave("/api/company", { name: value })
        : onSave("/api/company/join", { code: value });
    void save.then(() => {
      setDraft("");
      setMode(null);
    });
  };

  const pick = (next: "join" | "create") => {
    if (mode === next && draft.trim()) {
      submit(next, draft);
      return;
    }
    setMode((current) => (current === next ? null : next));
    setDraft("");
  };

  return (
    <motion.div
      className="menu settings"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
    >
      <div className="settings-head">
        <span>Settings</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="settings-line">
        <span className="company-id">
          {company?.name ? <span className="settings-name">{company.name}</span> : <span>Company</span>}
        </span>
        {company?.code ? (
          <a className="company-code" href={invite}>
            {company.code}
          </a>
        ) : (
          <span className="settings-actions">
            <button type="button" aria-pressed={mode === "join"} onClick={() => pick("join")}>
              Join
            </button>
            <button type="button" aria-pressed={mode === "create"} onClick={() => pick("create")}>
              Create
            </button>
          </span>
        )}
      </div>
      {mode && !company?.name && (
        <form
          className="ask"
          onSubmit={(event) => {
            event.preventDefault();
            submit(mode, draft);
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={mode === "create" ? "Name" : "Code"}
            aria-label={mode === "create" ? "Company name" : "Company code"}
            autoFocus
          />
        </form>
      )}
      {error && <div className="err">{error}</div>}
    </motion.div>
  );
}

function ChangePanel({
  onClose,
  onCompany,
}: {
  onClose: () => void;
  onCompany: (next: CompanyView) => void;
}) {
  const [people, setPeople] = useState<Array<{ id: string; name: string; hourlyCents: number | null }>>([]);
  const [source, setSource] = useState<"square" | "manual">("manual");
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void fetch("/api/company/roster", { headers: ownerHeaders() })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.message || "Couldn't load people");
        if (cancel) return;
        setSource(body.source === "square" ? "square" : "manual");
        setPeople(body.people ?? []);
      })
      .catch((err) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Couldn't load people");
      });
    return () => {
      cancel = true;
    };
  }, []);

  const saveRate = async (id: string, raw: string) => {
    const dollars = Number(raw);
    const cents = Math.round(dollars * 100);
    if (!raw.trim() || !Number.isFinite(dollars) || cents <= 0) {
      setError("Enter an hourly rate");
      return;
    }
    setError(null);
    const res = await fetch(`/api/company/people/${id}`, {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ hourlyCents: cents }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.message || "Couldn't save that rate");
      return;
    }
    onCompany(body);
    setPeople(body.people ?? []);
  };

  const add = async () => {
    const dollars = Number(rate);
    const cents = Math.round(dollars * 100);
    if (!name.trim() || !rate.trim() || !Number.isFinite(dollars) || cents <= 0) {
      setError("Enter a name and an hourly rate");
      return;
    }
    setError(null);
    const res = await fetch("/api/company/people", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ name, hourlyCents: cents }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.message || "Couldn't add that person");
      return;
    }
    onCompany(body);
    setPeople(body.people ?? []);
    setName("");
    setRate("");
  };

  return (
    <motion.div
      className="menu settings"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
    >
      <div className="settings-head">
        <span>Change</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {source === "square" && <p className="pay-source">Square</p>}
      {people.map((person) => (
        <div className="pay-row" key={person.id}>
          <span>{person.name}</span>
          {source === "square" ? (
            <span>{person.hourlyCents ? `$${rateText(person.hourlyCents)}/hr` : "—"}</span>
          ) : (
            <span className="pay-rate">
              <span>$</span>
              <input
                aria-label={`${person.name} hourly rate`}
                defaultValue={rateText(person.hourlyCents ?? 2000)}
                inputMode="decimal"
                onBlur={(event) => void saveRate(person.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                }}
              />
              <span>/hr</span>
            </span>
          )}
        </div>
      ))}
      {source === "manual" && (
        <form
          className="ask"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name"
            aria-label="Person"
          />
          <input
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            placeholder="20"
            inputMode="decimal"
            aria-label="Hourly rate"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
          />
        </form>
      )}
      {error && <div className="err">{error}</div>}
    </motion.div>
  );
}

function PrintTape({
  events,
  onDone,
}: {
  events: PrintEvent[];
  onDone: (id: string) => void;
}) {
  return (
    <div className="tape">
      <AnimatePresence>
        {events.map((event) => (
          <TapePrint key={event.id} event={event} onDone={onDone} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function TapePrint({ event, onDone }: { event: PrintEvent; onDone: (id: string) => void }) {
  const point = event.kind === "input";
  const sale = event.kind === "sale";
  const moneyHit = event.kind === "hour_print" || (sale && event.outputCents > 0);
  const big = moneyHit && event.outputCents >= 2000;

  useEffect(() => {
    const life = big ? 2600 : point ? 1800 : 1400;
    const t = setTimeout(() => onDone(event.id), life);
    return () => clearTimeout(t);
  }, [event.id, big, point, onDone]);

  const tone = event.kind === "hour_print" ? "down" : sale ? "up" : point
      ? event.inputType === "email"
        ? "email"
        : event.inputType === "prompt"
          ? "prompt"
          : "message"
      : "money";
  const text = point ? `+${event.inputUnits || 1}` : event.label;

  return (
    <motion.div
      className={`print ${tone}${big ? " big" : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.16 }}
    >
      {text}
    </motion.div>
  );
}
