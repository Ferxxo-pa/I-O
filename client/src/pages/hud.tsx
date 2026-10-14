import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PIN_KEY, WHO_ID, clearShopPin, setShopPin, shopPin, useIoState } from "@/hooks/useEarnState";
import { ching, clearedChime, unlockChing } from "@/lib/ching";
import {
  DEFAULT_FIGHT_SETTINGS,
  demoModel,
  hitTier,
  saleTapeLabel,
  type DemoScene,
  type FightSettings,
} from "@shared/fight";
import { demoOps, demoReadiness, payoutCsv, type OpsView, type ReadinessCheck } from "@shared/ops";
import type { CompanyState, PrintEvent } from "@shared/schema";

type CompanyView = CompanyState & { owner?: boolean; square?: boolean; ownerKey?: string };

const OWNER_STORE = "io.owner";
const WHO_NAME = "io.who.name";

type TeamPerson = { id: string; name: string };

function ownerHeaders(): Record<string, string> {
  const key = localStorage.getItem(OWNER_STORE);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["x-owner-key"] = key;
  const pin = sessionStorage.getItem(PIN_KEY);
  if (pin) headers["x-shop-pin"] = pin;
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

function compact(cents: number): string {
  const n = cents / 100;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function whole(cents: number): string {
  return Math.round(cents / 100).toLocaleString("en-US");
}

function toGo(cents: number): string {
  const dollars = Math.max(1, Math.ceil(cents / 100));
  return `$${dollars.toLocaleString("en-US")} to go`;
}

function readDemo(): DemoScene | null {
  const value = new URLSearchParams(window.location.search).get("demo");
  if (value === "morning" || value === "crit" || value === "cleared" || value === "idle") return value;
  return null;
}

function readStreakOverride(): number | null {
  const value = new URLSearchParams(window.location.search).get("streak");
  if (value == null || !/^\d{1,4}$/.test(value)) return null;
  return Number(value);
}

function readPanel(): "menu" | "levels" | "payout" | "checklist" | null {
  const value = new URLSearchParams(window.location.search).get("panel");
  if (value === "menu" || value === "levels" || value === "payout" || value === "checklist") return value;
  return null;
}

function levelLine(ops: OpsView): string {
  const every = Math.max(1, ops.rules.clearsInARow);
  const into = ops.consecutiveClears % every;
  const left = into === 0 ? every : every - into;
  const dayWord = left === 1 ? "day" : "days";
  const next = ops.level + 1;
  if (ops.level <= 0) return `${left} more ${dayWord} to Level ${next}`;
  return `Level ${ops.level} · ${left} more ${dayWord} to Level ${next}`;
}

const OPEN_DAYS: Array<[number, string, string]> = [
  [1, "M", "Monday"],
  [2, "T", "Tuesday"],
  [3, "W", "Wednesday"],
  [4, "T", "Thursday"],
  [5, "F", "Friday"],
  [6, "S", "Saturday"],
  [0, "S", "Sunday"],
];

function rateText(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return String(dollars);
  return dollars.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export default function Hud() {
  const { state, error, pending, freshEvents, dismissTick, refresh, clockIn, clockOut } = useIoState();
  const [menu, setMenu] = useState(() => readPanel() === "menu");
  const [settings, setSettings] = useState(false);
  const [levelsOpen, setLevelsOpen] = useState(() => readPanel() === "levels");
  const [payoutOpen, setPayoutOpen] = useState(() => readPanel() === "payout");
  const [checklistOpen, setChecklistOpen] = useState(() => readPanel() === "checklist");
  const [change, setChange] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  const [whoMode, setWhoMode] = useState<"clock" | "link">("clock");
  const [team, setTeam] = useState<TeamPerson[]>([]);
  const [teamSource, setTeamSource] = useState<"square" | "manual">("manual");
  const [youName, setYouName] = useState<string | null>(() => localStorage.getItem(WHO_NAME));
  const [collapsed, setCollapsed] = useState(false);
  const [chips, setChips] = useState(threeColors);
  const [company, setCompany] = useState<CompanyView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [demoScene] = useState<DemoScene | null>(readDemo);
  const [pinOpen, setPinOpen] = useState(false);
  const [afterPin, setAfterPin] = useState<"clock" | "settings" | "change" | null>(null);
  const heard = useRef(new Set<string>());
  const wasCleared = useRef<boolean | null>(null);
  const demo = demoScene ? demoModel(demoScene) : null;

  useEffect(() => {
    const unlock = () => unlockChing();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    if (demo) return;
    for (const event of freshEvents) {
      if (heard.current.has(event.id)) continue;
      heard.current.add(event.id);
      if (event.kind === "sale" && event.outputCents > 0) {
        ching(hitTier(event.outputCents));
      }
    }
  }, [freshEvents, demo]);

  useEffect(() => {
    if (demo?.scene !== "crit") return;
    ching("crit");
  }, [demo?.scene]);

  const fight = demo?.view ?? state?.fight ?? null;
  const ops = demo ? demoOps(demo.scene) : (state?.ops ?? null);
  const streakOverride = demo ? readStreakOverride() : null;
  const dayStreak = streakOverride ?? fight?.streak ?? 0;
  const pinSet = state?.fight.pinSet ?? false;

  useEffect(() => {
    if (demo) return;
    if (!fight?.cleared) {
      wasCleared.current = fight ? false : wasCleared.current;
      return;
    }
    if (wasCleared.current !== false) {
      wasCleared.current = true;
      return;
    }
    wasCleared.current = true;
    const key = `io.cleared.${fight.date}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    clearedChime();
  }, [demo, fight]);

  useEffect(() => {
    if (error === "Wrong PIN" || error === "Too many tries") {
      clearShopPin();
      setPinOpen(true);
    }
  }, [error]);

  const live = demo ? demo.clockedIn : (state?.session.clockedIn ?? false);
  const moneyOut = fight ? fight.todayWageCents : (state?.session.outputCents ?? 0) + (state?.accruedOutputCents ?? 0);
  const moneyIn = fight ? fight.todayCollectedCents : (state?.session.collectedCents ?? 0);
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
  const wide = (menu || settings || levelsOpen || payoutOpen || checklistOpen || change || whoOpen || pinOpen) && !collapsed;
  const demoHit = useMemo<PrintEvent | null>(() => {
    if (!demo?.hitCents) return null;
    return {
      id: `demo-${demo.scene}`,
      kind: "sale",
      outputCents: demo.hitCents,
      inputUnits: 0,
      label: saleTapeLabel(demo.hitCents),
      createdAt: 0,
    };
  }, [demo]);

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

  const saveFight = async (path: string, body: unknown) => {
    setSettingsError(null);
    const res = await fetch(path, {
      method: path.endsWith("/pin") || path.includes("/approve") ? "POST" : "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify(body),
    });
    const next = (await res.json()) as { message?: string };
    if (!res.ok) {
      if (res.status === 401 || res.status === 429) clearShopPin();
      throw new Error(next.message || "Couldn't save that");
    }
    if (path.endsWith("/pin") && body && typeof body === "object" && "pin" in body) {
      setShopPin(String((body as { pin: string }).pin));
    }
    await refresh();
  };

  const openWho = async (mode: "clock" | "link") => {
    setMenu(false);
    setSettings(false);
    setChange(false);
    setWhoMode(mode);
    setWhoOpen(true);
    const res = await fetch("/api/company/who");
    const body = (await res.json()) as { people?: TeamPerson[]; source?: "square" | "manual"; message?: string };
    if (!res.ok) {
      setTeam([]);
      return;
    }
    setTeam(body.people ?? []);
    setTeamSource(body.source === "square" ? "square" : "manual");
  };

  const choosePerson = (person: TeamPerson) => {
    localStorage.setItem(WHO_ID, person.id);
    localStorage.setItem(WHO_NAME, person.name);
    setYouName(person.name);
    setWhoOpen(false);
    if (whoMode === "clock") {
      if (demo) return;
      if (!guard("clock")) return;
      clockIn();
    } else void refresh();
  };

  const closePanels = () => {
    setMenu(false);
    setSettings(false);
    setLevelsOpen(false);
    setPayoutOpen(false);
    setChecklistOpen(false);
    setChange(false);
  };

  const guard = (next: "clock" | "settings" | "change") => {
    if (demo && next === "clock") return false;
    if (!pinSet) {
      if (next === "clock") {
        setSettings(true);
        setSettingsError("Set a shop PIN first");
        return false;
      }
      return true;
    }
    if (!shopPin()) {
      setAfterPin(next);
      setPinOpen(true);
      setMenu(false);
      return false;
    }
    return true;
  };

  const finishPin = (pin: string) => {
    setShopPin(pin);
    setPinOpen(false);
    const next = afterPin;
    setAfterPin(null);
    if (next === "settings") setSettings(true);
    else if (next === "change") setChange(true);
    else if (next === "clock") {
      if (live) clockOut();
      else clockIn();
    }
  };

  const toggle = () => {
    if (demo) return;
    if (pending || !state) return;
    if (!localStorage.getItem(WHO_ID)) {
      void openWho("clock");
      return;
    }
    if (!guard("clock")) return;
    if (live) clockOut();
    else clockIn();
  };

  return (
    <div className="stage">
      <div className="strip-anchor">
        <PrintTape
          events={demo ? (demoHit ? [demoHit] : []) : freshEvents}
          onDone={dismissTick}
          hold={Boolean(demo)}
        />

        <div
          className={`strip ${live ? "live" : "idle"}${collapsed ? " collapsed" : ""}${wide ? " with-panel" : ""}`}
          data-clock={live ? "in" : "out"}
          data-fight={fight?.cleared && live ? "cleared" : "behind"}
        >
          <span className="chips" aria-hidden>
            {chips.map((color, index) => (
              <i key={index} style={live ? { background: color } : undefined} />
            ))}
          </span>
          <div className="ctrl-row">
            <button
              type="button"
              className="mark ctrl"
              onClick={toggle}
              disabled={pending || !state}
              title={live ? "Clock out" : youName || "Clock in"}
            >
              I/O
              <span className="tip">{live ? "Clock out" : youName || "Clock in"}</span>
            </button>
            <span className="actions">
              {!collapsed && (
                <button type="button" className="plus ctrl" onClick={() => setMenu((open) => !open)} aria-label="More">
                  +
                </button>
              )}
              <button
                type="button"
                className="fold ctrl"
                onClick={() => {
                  setCollapsed((open) => !open);
                  setMenu(false);
                  setSettings(false);
                  setChange(false);
                  setWhoOpen(false);
                  setPinOpen(false);
                }}
                aria-label={collapsed ? "Expand" : "Collapse"}
              >
                {collapsed ? "›" : "‹"}
              </button>
            </span>
          </div>
          {!collapsed && (
            <span className={`fight-cta${fight?.cleared && live ? " won" : ""}`}>
              {fight?.cleared ? `pot $${whole(fight.potCents)}` : fight && fight.toBreakEvenCents > 0 ? toGo(fight.toBreakEvenCents) : ""}
            </span>
          )}
          {!collapsed && (
            <span className={`balance-bar${fight?.cleared && live ? " won" : ""}`} aria-hidden>
              {combined > 0 && (
                <>
                  <i className="in" style={{ width: `${greenShare}%` }} />
                  <i className="out" style={{ width: `${redShare}%` }} />
                </>
              )}
            </span>
          )}
          {!collapsed && (
            <span className="nums">
              <span className="num up">+${money(moneyIn)}</span>
              <span className="num down">−${money(moneyOut)}</span>
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
              {fight && (
                <div className="menu-row">
                  <span>Today</span>
                  <span>{fight.cleared ? "Goal hit 🎉" : `$${whole(fight.toBreakEvenCents)} to go`}</span>
                </div>
              )}
              {ops && (
                <div className="menu-row">
                  <span>This week</span>
                  <span>
                    {ops.week.cleared
                      ? "Week goal hit"
                      : `$${whole(Math.max(0, ops.week.breakEvenCents - ops.week.collectedCents))} to go`}
                  </span>
                </div>
              )}
              {fight && (
                <div className="menu-row">
                  <span className={`streak${dayStreak === 0 ? " cold" : ""}`}>
                    <span className="fire" aria-hidden>
                      🔥
                    </span>
                    {dayStreak === 1 ? "1 day in a row" : `${dayStreak} days in a row`}
                  </span>
                </div>
              )}
              {ops && (
                <div className="menu-row">
                  <span>{levelLine(ops)}</span>
                </div>
              )}
              {ops && (
                <div className="menu-row">
                  <span>Team bonus</span>
                  <span>${whole(ops.week.potCents)}</span>
                </div>
              )}
              {ops?.nudge && <p className="menu-note">{ops.nudge}</p>}
              <button
                type="button"
                className="menu-settings"
                onClick={() => {
                  closePanels();
                  if (!guard("settings")) return;
                  setSettings(true);
                }}
              >
                Settings
              </button>
              {error && <div className="err">{error}</div>}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {levelsOpen && ops && (
            <LevelsPanel
              ops={ops}
              demo={Boolean(demo)}
              onClose={() => setLevelsOpen(false)}
              onSave={(body) => saveFight("/api/fight/levels", body)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {payoutOpen && ops && (
            <PayoutPanel
              ops={ops}
              demo={Boolean(demo)}
              onClose={() => setPayoutOpen(false)}
              onApprove={async (weekStart) => {
                if (demo) return;
                await saveFight(`/api/fight/payouts/${weekStart}/approve`, {});
              }}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {checklistOpen && (
            <ChecklistPanel demo={Boolean(demo)} onClose={() => setChecklistOpen(false)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {settings && (
            <SettingsPanel
              company={company}
              youName={youName}
              live={live && !demo}
              settings={state?.fight.settings ?? null}
              pinSet={pinSet}
              error={settingsError}
              onLink={() => void openWho("link")}
              onClose={() => setSettings(false)}
              onLevels={() => {
                closePanels();
                setLevelsOpen(true);
              }}
              onPayout={() => {
                closePanels();
                setPayoutOpen(true);
              }}
              onReady={() => {
                closePanels();
                setChecklistOpen(true);
              }}
              onChange={() => {
                closePanels();
                if (!guard("change")) return;
                setChange(true);
              }}
              onFight={async (path, body) => {
                try {
                  await saveFight(path, body);
                } catch (err) {
                  setSettingsError(err instanceof Error ? err.message : "Couldn't save that");
                  throw err;
                }
              }}
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

        <AnimatePresence>
          {pinOpen && (
            <PinPanel
              onClose={() => setPinOpen(false)}
              onSubmit={finishPin}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {whoOpen && (
            <WhoPanel
              people={team}
              source={teamSource}
              onChoose={choosePerson}
              onClose={() => setWhoOpen(false)}
            />
          )}
        </AnimatePresence>
        {error && !menu && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

function WhoPanel({
  people,
  source,
  onChoose,
  onClose,
}: {
  people: TeamPerson[];
  source: "square" | "manual";
  onChoose: (person: TeamPerson) => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      className="menu settings"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
    >
      <div className="settings-head">
        <span>{source === "square" ? "Square" : "You"}</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {people.map((person) => (
        <button key={person.id} type="button" className="menu-row who" onClick={() => onChoose(person)}>
          <span>{person.name}</span>
        </button>
      ))}
      {people.length === 0 && (
        <div className="menu-row">
          <span>{source === "square" ? "Nobody on the Square team yet" : "The owner adds people in Change"}</span>
        </div>
      )}
    </motion.div>
  );
}

function PinPanel({ onClose, onSubmit }: { onClose: () => void; onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  return (
    <motion.div
      className="menu settings"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
    >
      <div className="settings-head">
        <span>Shop PIN</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <form
        className="ask"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^\d{4,8}$/.test(pin)) return;
          onSubmit(pin);
        }}
      >
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder="PIN"
          aria-label="Shop PIN"
          inputMode="numeric"
          autoComplete="off"
          type="password"
          autoFocus
        />
      </form>
    </motion.div>
  );
}

function SettingsPanel({
  company,
  youName,
  live,
  settings,
  pinSet,
  error,
  onLink,
  onClose,
  onFight,
  onSave,
  onLevels,
  onPayout,
  onReady,
  onChange,
}: {
  company: CompanyView | null;
  youName: string | null;
  live: boolean;
  settings: FightSettings | null;
  pinSet: boolean;
  error: string | null;
  onLink: () => void;
  onClose: () => void;
  onFight: (path: string, body: unknown) => Promise<void>;
  onSave: (path: string, body: unknown) => Promise<void>;
  onLevels: () => void;
  onPayout: () => void;
  onReady: () => void;
  onChange: () => void;
}) {
  const [mode, setMode] = useState<"join" | "create" | null>(null);
  const [draft, setDraft] = useState("");
  const [pin, setPin] = useState("");
  const [fixed, setFixed] = useState("");
  const [materials, setMaterials] = useState("");
  const [fee, setFee] = useState("");
  const [pot, setPot] = useState("");
  const [goal, setGoal] = useState("");
  const [days, setDays] = useState<number[]>(DEFAULT_FIGHT_SETTINGS.openWeekdays);
  const [rent, setRent] = useState(false);
  const [ready, setReady] = useState(false);
  const invite = company?.code ? `${window.location.origin}/?join=${company.code}` : "";

  useEffect(() => {
    if (!settings || ready) return;
    setFixed(String(settings.fixedMonthlyCents / 100));
    setMaterials(String(settings.materialsBps / 100));
    setFee(String(settings.feeBps / 100));
    setPot(String(settings.potBps / 100));
    setGoal(String(settings.avgGoalCents / 100));
    setDays(settings.openWeekdays);
    setRent(settings.rentEntered);
    setReady(true);
  }, [settings, ready]);

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
        <button type="button" className="settings-name" onClick={() => { if (!live) onLink(); }}>
          {youName || "Link"}
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
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pinSet) {
            void onFight("/api/fight/pin", { pin });
            return;
          }
          void onFight("/api/fight/settings", {
            fixedMonthlyCents: Math.round(Number(fixed) * 100),
            materialsBps: Math.round(Number(materials) * 100),
            feeBps: Math.round(Number(fee) * 100),
            openWeekdays: days,
            potBps: Math.round(Number(pot) * 100),
            avgGoalCents: Math.round(Number(goal) * 100),
            rentEntered: rent,
          });
        }}
      >
        {!pinSet && company?.owner && (
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
            placeholder="Shop PIN"
            aria-label="Shop PIN"
            inputMode="numeric"
            autoComplete="off"
            type="password"
          />
        )}
        {pinSet && (
          <>
            <label className="settings-line">
              <span>Fixed / month</span>
              <input value={fixed} onChange={(event) => setFixed(event.target.value)} inputMode="decimal" aria-label="Fixed costs per month" />
            </label>
            <label className="settings-line">
              <span>Materials %</span>
              <input value={materials} onChange={(event) => setMaterials(event.target.value)} inputMode="decimal" aria-label="Materials percent" />
            </label>
            <label className="settings-line">
              <span>Fee %</span>
              <input value={fee} onChange={(event) => setFee(event.target.value)} inputMode="decimal" aria-label="Fee percent" />
            </label>
            <label className="settings-line">
              <span>Pot %</span>
              <input value={pot} onChange={(event) => setPot(event.target.value)} inputMode="decimal" aria-label="Team pot percent" />
            </label>
            <label className="settings-line">
              <span>Avg goal</span>
              <input value={goal} onChange={(event) => setGoal(event.target.value)} inputMode="decimal" aria-label="Average sale goal" />
            </label>
            <label className="settings-line">
              <span>Rent included</span>
              <input
                type="checkbox"
                checked={rent}
                onChange={(event) => setRent(event.target.checked)}
                aria-label="Rent is included in fixed costs"
              />
            </label>
          </>
        )}
        {(pinSet || company?.owner) && (
          <button type="submit">{pinSet ? "Save" : "Set PIN"}</button>
        )}
      </form>
      {pinSet && (
        <div className="settings-actions">
          {OPEN_DAYS.map(([day, letter, name]) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              aria-pressed={days.includes(day)}
              onClick={() =>
                setDays((current) => {
                  if (current.includes(day)) return current.length === 1 ? current : current.filter((item) => item !== day);
                  return [...current, day];
                })
              }
            >
              {letter}
            </button>
          ))}
        </div>
      )}
      <div className="menu-actions">
        <button type="button" onClick={onLevels}>
          Levels
        </button>
        <button type="button" onClick={onPayout}>
          Team bonus
        </button>
        <button type="button" onClick={onReady}>
          Checklist
        </button>
        {company?.owner && (
          <button type="button" onClick={onChange}>
            Pay rates
          </button>
        )}
      </div>
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

function LevelsPanel({
  ops,
  demo,
  onClose,
  onSave,
}: {
  ops: OpsView;
  demo: boolean;
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [days, setDays] = useState(String(ops.rules.clearsInARow));
  const [rows, setRows] = useState(
    ops.rules.table.map((row) => ({
      level: String(row.level),
      pay: rateText(row.payBumpCents),
      pot: String(row.potBonusBps / 100),
    })),
  );
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const table = rows.map((row) => ({
      level: Math.round(Number(row.level)),
      payBumpCents: Math.round(Number(row.pay) * 100),
      potBonusBps: Math.round(Number(row.pot) * 100),
    }));
    if (demo) return;
    try {
      setError(null);
      await onSave({ clearsInARow: Math.round(Number(days)), table });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save levels");
    }
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
        <span>Levels</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="menu-note">Clear open days in a row. Square wages stay put.</p>
      <div className="menu-row">
        <span>Weeks in a row</span>
        <span>{ops.weekStreak}</span>
      </div>
      <label className="settings-line">
        <span>Days</span>
        <input value={days} onChange={(event) => setDays(event.target.value)} inputMode="numeric" aria-label="Open days in a row" />
      </label>
      <div className="menu-row">
        <span>$/hr</span>
        <span>Pot %</span>
      </div>
      {rows.map((row, index) => (
        <div className="level-grid" key={index}>
          <span>{row.level}</span>
          <input
            value={row.pay}
            aria-label={`Level ${row.level} pay bump`}
            inputMode="decimal"
            onChange={(event) =>
              setRows((current) => current.map((item, i) => (i === index ? { ...item, pay: event.target.value } : item)))
            }
          />
          <input
            value={row.pot}
            aria-label={`Level ${row.level} pot percent`}
            inputMode="decimal"
            onChange={(event) =>
              setRows((current) => current.map((item, i) => (i === index ? { ...item, pot: event.target.value } : item)))
            }
          />
        </div>
      ))}
      {ops.history.map((step) => (
        <div className="menu-row" key={`${step.date}-${step.toLevel}`}>
          <span>{step.date}</span>
          <span>
            {step.fromLevel} → {step.toLevel}
          </span>
        </div>
      ))}
      <div className="menu-actions">
        <button type="button" onClick={() => void save()}>
          Save
        </button>
      </div>
      {error && <div className="err">{error}</div>}
    </motion.div>
  );
}

function PayoutPanel({
  ops,
  demo,
  onClose,
  onApprove,
}: {
  ops: OpsView;
  demo: boolean;
  onClose: () => void;
  onApprove: (weekStart: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const hours = (ms: number) => (ms / 3_600_000).toFixed(1);

  const download = async () => {
    setError(null);
    try {
      const text = demo
        ? payoutCsv(ops.payout ? [ops.payout] : [])
        : await (async () => {
            if (pin && !shopPin()) setShopPin(pin);
            const res = await fetch("/api/fight/payouts.csv", { headers: ownerHeaders() });
            const body = await res.text();
            if (!res.ok) {
              const message = body.startsWith("{") ? (JSON.parse(body) as { message?: string }).message : "";
              throw new Error(message || "Couldn't export the pot");
            }
            return body;
          })();
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "pot-payouts.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't export the pot");
    }
  };

  const approve = async () => {
    if (!ops.payout || ops.payout.status === "paid") return;
    setError(null);
    try {
      if (!demo && pin && !shopPin()) setShopPin(pin);
      await onApprove(ops.payout.weekStart);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't approve that week");
    }
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
        <span>Payout</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="menu-note">Mon–Fri pot by timecard hours. Approving does not change Square.</p>
      <div className="menu-row">
        <span>This week</span>
        <span>
          ${whole(ops.week.collectedCents)} / ${whole(ops.week.breakEvenCents)}
        </span>
      </div>
      {ops.week.shares.map((share) => (
        <div className="menu-row" key={share.id}>
          <span>
            {share.name.split(" ")[0]} · {hours(share.ms)}h
          </span>
          <span>${compact(share.cents)}</span>
        </div>
      ))}
      {ops.payout && (
        <>
          <div className="menu-row">
            <span>Week of {ops.payout.weekStart.slice(5)}</span>
            <span>
              ${compact(ops.payout.potCents)} {ops.payout.status}
            </span>
          </div>
          {ops.payout.shares.map((share) => (
            <div className="menu-row" key={`pay-${share.id}`}>
              <span>
                {share.name.split(" ")[0]} · {hours(share.ms)}h
              </span>
              <span>${compact(share.cents)}</span>
            </div>
          ))}
        </>
      )}
      {!demo && !shopPin() && (
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder="Shop PIN"
          aria-label="Shop PIN"
          inputMode="numeric"
          type="password"
          autoComplete="off"
        />
      )}
      <div className="menu-actions">
        {ops.payout && ops.payout.status === "open" && (
          <button type="button" onClick={() => void approve()}>
            Approve
          </button>
        )}
        <button type="button" onClick={() => void download()}>
          CSV
        </button>
      </div>
      {error && <div className="err">{error}</div>}
    </motion.div>
  );
}

function ChecklistPanel({ demo, onClose }: { demo: boolean; onClose: () => void }) {
  const [checks, setChecks] = useState<ReadinessCheck[]>(() => (demo ? demoReadiness().checks : []));
  const [scope, setScope] = useState<string>(demo ? "local" : "");
  const [ready, setReady] = useState(demo ? demoReadiness().ready : false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (demo) return;
    let cancel = false;
    void fetch("/api/health")
      .then(async (res) => {
        const body = (await res.json()) as {
          ready?: boolean;
          scope?: { locationId?: string };
          checks?: ReadinessCheck[];
          message?: string;
        };
        if (!res.ok) throw new Error(body.message || "Couldn't load the checklist");
        if (cancel) return;
        setChecks(body.checks ?? []);
        setReady(Boolean(body.ready));
        setScope(body.scope?.locationId ?? "");
      })
      .catch((err) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Couldn't load the checklist");
      });
    return () => {
      cancel = true;
    };
  }, [demo]);

  return (
    <motion.div
      className="menu settings"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
    >
      <div className="settings-head">
        <span>Ready</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="menu-row">
        <span>Go live</span>
        <span>{ready ? "Yes" : "No"}</span>
      </div>
      {scope && (
        <div className="menu-row">
          <span>Location</span>
          <span>{scope}</span>
        </div>
      )}
      {checks.map((check) => (
        <div className={`menu-row${check.ok ? "" : " soft"}`} key={check.id}>
          <span>{check.label}</span>
          <span>{check.ok ? "Yes" : check.detail}</span>
        </div>
      ))}
      {error && <div className="err">{error}</div>}
    </motion.div>
  );
}

function PrintTape({
  events,
  onDone,
  hold = false,
}: {
  events: PrintEvent[];
  onDone: (id: string) => void;
  hold?: boolean;
}) {
  return (
    <div className="tape">
      <AnimatePresence>
        {events.map((event) => (
          <TapePrint key={event.id} event={event} onDone={onDone} hold={hold} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function TapePrint({
  event,
  onDone,
  hold = false,
}: {
  event: PrintEvent;
  onDone: (id: string) => void;
  hold?: boolean;
}) {
  const point = event.kind === "input";
  const sale = event.kind === "sale" && event.outputCents > 0;
  const tier = sale ? hitTier(event.outputCents) : null;
  const big = !tier && event.kind === "hour_print" && event.outputCents >= 2000;
  const life = tier === "crit" ? 1900 : tier === "big" ? 1500 : tier === "solid" ? 1200 : tier === "small" ? 900 : big ? 1600 : point ? 1400 : 1200;
  const peak = tier === "crit" ? 1.65 : tier === "big" ? 1.42 : tier === "solid" ? 1.28 : 1.12;

  useEffect(() => {
    if (hold) return;
    const t = setTimeout(() => onDone(event.id), life);
    return () => clearTimeout(t);
  }, [event.id, onDone, hold, life]);

  const tone = event.kind === "hour_print" ? "down" : sale ? "up" : point
      ? event.inputType === "email"
        ? "email"
        : event.inputType === "prompt"
          ? "prompt"
          : "message"
      : "money";
  const text = point ? `+${event.inputUnits || 1}` : event.label;

  if (tier) {
    return (
      <motion.div
        className={`print up tier-${tier}`}
        initial={{ opacity: 0, y: 14, scale: 0.35 }}
        animate={
          hold
            ? { opacity: 1, y: -12, scale: peak }
            : { opacity: [0, 1, 1, 0], y: [14, -8, -18, -40], scale: [0.35, peak, peak * 0.94, 0.8] }
        }
        transition={
          hold
            ? { duration: 0.72, ease: [0.16, 1, 0.3, 1] }
            : { duration: life / 1000, times: [0, 0.16, 0.4, 1], ease: [0.16, 1, 0.3, 1] }
        }
      >
        {text}
      </motion.div>
    );
  }

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
