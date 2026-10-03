import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useIoState } from "@/hooks/useEarnState";
import { ching, unlockChing } from "@/lib/ching";
import type { CompanyState, PrintEvent } from "@shared/schema";

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
  const [collapsed, setCollapsed] = useState(false);
  const [chips, setChips] = useState(threeColors);

  useEffect(() => {
    const id = window.setInterval(() => setChips(threeColors()), 3200);
    return () => window.clearInterval(id);
  }, []);
  const [company, setCompany] = useState<CompanyState | null>(null);
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
      const paid = event.kind === "hour_print" || event.kind === "sale";
      if (paid && event.outputCents > 0) ching();
    }
  }, [freshEvents]);

  const live = state?.session.clockedIn ?? false;
  const moneyOut = (state?.session.outputCents ?? 0) + (state?.accruedOutputCents ?? 0);
  const moneyIn = state?.session.collectedCents ?? 0;
  const points = state?.session.inputUnits ?? 0;
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const shown = `$${money(Math.abs(moneyOut))}`;
  const wide = (menu || settings) && !collapsed;

  useEffect(() => {
    let cancel = false;
    fetch("/api/company")
      .then((res) => res.json())
      .then((next: CompanyState) => {
        if (!cancel) setCompany(next);
      })
      .catch(() => {
        if (!cancel) setSettingsError("Couldn't load settings");
      });
    return () => {
      cancel = true;
    };
  }, []);

  const saveCompany = async (path: string, body: unknown) => {
    setSettingsError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const next = await res.json();
    if (!res.ok) throw new Error(next.message || "Couldn't save that");
    setCompany(next);
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
              <i key={index} style={{ background: color }} />
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
            <span className="dot" />
            <span className="tip">{live ? "Clock out" : "Clock in"}</span>
          </button>
          {!collapsed && <span className="num">{shown}</span>}
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
            }}
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "›" : "‹"}
          </button>
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
              <FlowBar inCents={moneyIn} outCents={moneyOut} />
              <div className="menu-row">
                <span>Points</span>
                <span>{points}</span>
              </div>
              <div className="menu-actions">
                <button
                  type="button"
                  onClick={() => {
                    setSettings(true);
                    setMenu(false);
                  }}
                >
                  Settings
                </button>
              </div>
              {error && <div className="err">{error}</div>}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {settings && (
            <SettingsPanel
              company={company}
              squareOn={state?.square.connected ?? false}
              rate={rateText(rateCents)}
              telegram={company?.integrations.find((item) => item.kind === "telegram")?.account ?? null}
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
      </div>
    </div>
  );
}

function FlowBar({ inCents, outCents }: { inCents: number; outCents: number }) {
  const total = inCents + outCents;
  let inShare = 0;
  if (total > 0) {
    inShare = inCents / total;
    if (inCents > 0 && outCents > 0) inShare = Math.min(0.94, Math.max(0.06, inShare));
  }
  const outShare = total > 0 ? 1 - inShare : 0;

  return (
    <div className="flow">
      <div className="flow-top">
        <span className="in">In ${money(inCents)}</span>
        <span className="out">Out ${money(outCents)}</span>
      </div>
      <div
        className="track"
        role="img"
        aria-label={`In ${money(inCents)} dollars, out ${money(outCents)} dollars`}
      >
        {inShare > 0 && <span className="in" style={{ width: `${inShare * 100}%` }} />}
        {outShare > 0 && <span className="out" style={{ width: `${outShare * 100}%` }} />}
      </div>
    </div>
  );
}

function SettingsPanel({
  company,
  squareOn,
  rate,
  telegram,
  error,
  onClose,
  onSave,
}: {
  company: CompanyState | null;
  squareOn: boolean;
  rate: string;
  telegram: string | null;
  error: string | null;
  onClose: () => void;
  onSave: (path: string, body: unknown) => Promise<void>;
}) {
  const [personName, setPersonName] = useState("");
  const [personTelegram, setPersonTelegram] = useState("");
  const [handle, setHandle] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  const people = [...(company?.people ?? [])].sort((a, b) => a.name.localeCompare(b.name));

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

      <section className="settings-block">
        <p className="settings-label">Pay</p>
        <div className="menu-row">
          <span>Rate</span>
          <span>${rate}/hr</span>
        </div>
      </section>

      <section className="settings-block">
        <p className="settings-label">Telegram</p>
        {telegram && (
          <div className="menu-row">
            <span>@{telegram}</span>
            <span>Connected</span>
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave("/api/integrations", { kind: "telegram", account: handle });
            setHandle("");
          }}
        >
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="@username"
            aria-label="Telegram username"
          />
          <button type="submit">{telegram ? "Update" : "Connect"}</button>
        </form>
        <p className="settings-note">Group chat later. Each message is a point.</p>
      </section>

      <section className="settings-block">
        <p className="settings-label">Company</p>
        {company?.name ? (
          <>
            <div className="menu-row">
              <span className="settings-name">{company.name}</span>
              {company.code && <span className="company-code">{company.code}</span>}
            </div>
            <div className="menu-row">
              <span>You</span>
            </div>
            {people.map((person) => (
              <div className="menu-row" key={person.id}>
                <span>{person.name}</span>
                <span>{person.telegram ? `@${person.telegram}` : ""}</span>
              </div>
            ))}
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void onSave("/api/company/people", { name: personName, telegram: personTelegram });
                setPersonName("");
                setPersonTelegram("");
              }}
            >
              <input
                value={personName}
                onChange={(event) => setPersonName(event.target.value)}
                placeholder="Name"
                aria-label="Person name"
              />
              <div className="form-line">
                <input
                  value={personTelegram}
                  onChange={(event) => setPersonTelegram(event.target.value)}
                  placeholder="@telegram"
                  aria-label="Person Telegram"
                />
                <button type="submit">Add</button>
              </div>
            </form>
          </>
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const save = creating
                  ? onSave("/api/company", { name: draft })
                  : onSave("/api/company/join", { code: draft });
                void save.then(() => setDraft(""));
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={creating ? "Name" : "Code"}
                aria-label={creating ? "Company name" : "Company code"}
              />
              <button type="submit">{creating ? "Create" : "Join"}</button>
            </form>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setCreating((open) => !open);
                setDraft("");
              }}
            >
              {creating ? "Join" : "Create"}
            </button>
          </>
        )}
      </section>

      <section className="settings-block">
        <p className="settings-label">Later</p>
        <div className="menu-row">
          <span>Square</span>
          <span>{squareOn ? "Connected" : "Soon"}</span>
        </div>
      </section>
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

  const tone = sale
    ? "sale"
    : point
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
