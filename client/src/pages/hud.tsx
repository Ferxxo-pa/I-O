import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useIoState } from "@/hooks/useEarnState";
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
  const { state, error, pending, freshEvents, dismissTick, clockIn, clockOut, reset } = useIoState();
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

  const live = state?.session.clockedIn ?? false;
  const output = (state?.session.outputCents ?? 0) + (state?.accruedOutputCents ?? 0);
  const points = state?.session.inputUnits ?? 0;
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const shown = `$${money(Math.abs(output))}`;

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

        <div className={`strip ${live ? "live" : "idle"}${collapsed ? " collapsed" : ""}`}>
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
              <div className="menu-row">
                <span>Made</span>
                <span>{shown}</span>
              </div>
              <div className="menu-row">
                <span>Points</span>
                <span>{points}</span>
              </div>
              <div className="menu-row">
                <span>Rate</span>
                <span>${rateText(rateCents)}/hr</span>
              </div>
              <div className="menu-actions">
                <button type="button" disabled={pending} onClick={() => reset()}>
                  Reset
                </button>
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
              made={shown}
              points={points}
              telegram={company?.integrations.find((item) => item.kind === "telegram")?.account ?? null}
              error={settingsError}
              onClose={() => setSettings(false)}
              onSave={async (path, body) => {
                try {
                  await saveCompany(path, body);
                } catch (err) {
                  setSettingsError(err instanceof Error ? err.message : "Couldn't save that");
                }
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function SettingsPanel({
  company,
  squareOn,
  made,
  points,
  telegram,
  error,
  onClose,
  onSave,
}: {
  company: CompanyState | null;
  squareOn: boolean;
  made: string;
  points: number;
  telegram: string | null;
  error: string | null;
  onClose: () => void;
  onSave: (path: string, body: unknown) => Promise<void>;
}) {
  const [companyName, setCompanyName] = useState("");
  const [personName, setPersonName] = useState("");
  const [personTelegram, setPersonTelegram] = useState("");
  const [handle, setHandle] = useState("");

  const people = [...(company?.people ?? [])].sort(
    (a, b) => b.madeCents - a.madeCents || b.points - a.points,
  );

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

      <p className="settings-label">Telegram</p>
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
          placeholder={telegram ? `@${telegram}` : "@username"}
          aria-label="Telegram username"
        />
        <button type="submit">{telegram ? "Update" : "Connect"}</button>
      </form>

      <p className="settings-label">Later</p>
      <div className="menu-row">
        <span>Square</span>
        <span>{squareOn ? "Connected" : "Soon"}</span>
      </div>

      <p className="settings-label">Company</p>
      {company?.name ? (
        <>
          <div className="menu-row">
            <span>{company.name}</span>
            <span>Leaderboard</span>
          </div>
          <div className="board-row you">
            <span>You</span>
            <span>{made}</span>
            <span>{points}</span>
            <span>{telegram ? `@${telegram}` : ""}</span>
          </div>
          {people.map((person) => (
            <div className="board-row" key={person.id}>
              <span>{person.name}</span>
              <span>${money(person.madeCents)}</span>
              <span>{person.points}</span>
              <span>{person.telegram ? `@${person.telegram}` : ""}</span>
            </div>
          ))}
          <form
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
            <input
              value={personTelegram}
              onChange={(event) => setPersonTelegram(event.target.value)}
              placeholder="@telegram"
              aria-label="Person Telegram"
            />
            <button type="submit">Add</button>
          </form>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave("/api/company", { name: companyName });
            setCompanyName("");
          }}
        >
          <input
            value={companyName}
            onChange={(event) => setCompanyName(event.target.value)}
            placeholder="Company name"
            aria-label="Company name"
          />
          <button type="submit">Create</button>
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
