import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { OWNER_KEY, PIN_KEY, WHO_ID, authHeaders, clearShopPin, setShopPin, shopPin, useIoState } from "@/hooks/useEarnState";
import { apiUrl } from "@/serverUrl";
import { ching, clearedChime, unlockChing } from "@/lib/ching";
import {
  DEFAULT_FIGHT_SETTINGS,
  demoModel,
  hitTier,
  isOpenKey,
  saleTapeLabel,
  type DemoScene,
  type FightSettings,
  type FightView,
} from "@shared/fight";
import { demoOps, demoReadiness, type OpsView, type ReadinessCheck } from "@shared/ops";
import {
  copyLine,
  demoWeek,
  streakMark,
  menuLevel,
  menuWorkLine,
  shownWorkedDays,
  weekFillPct,
  type WeekPreset,
  type WeekView,
} from "@shared/week";
import { releaseNotes, type ReleaseNote } from "@shared/notes";
import type { PresenceView } from "@shared/presence";
import type { CompanyState, PrintEvent } from "@shared/schema";

type CompanyView = CompanyState & { owner?: boolean; square?: boolean; ownerKey?: string };

const OWNER_STORE = OWNER_KEY;
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

function dollars(cents: number): number {
  return Math.round(cents / 100);
}

function weekLine(week: WeekView, variant: number): string {
  return copyLine(week, variant);
}

function readDemo(): DemoScene | null {
  const value = new URLSearchParams(window.location.search).get("demo");
  if (value === "morning" || value === "crit" || value === "cleared" || value === "idle") return value;
  return null;
}

function readPanel(): "menu" | "levels" | "checklist" | "settings" | "news" | null {
  const value = new URLSearchParams(window.location.search).get("panel");
  if (value === "menu" || value === "levels" || value === "checklist" || value === "settings" || value === "news") return value;
  return null;
}

function readStill(): boolean {
  return new URLSearchParams(window.location.search).get("still") === "1";
}

function readWeek(): WeekPreset | null {
  const value = new URLSearchParams(window.location.search).get("week");
  if (value === "low" || value === "mid" || value === "stretch" || value === "covered" || value === "cushion") return value;
  return null;
}

function readWorked(): number | null {
  const raw = new URLSearchParams(window.location.search).get("worked");
  if (raw == null || !/^\d{1,4}$/.test(raw)) return null;
  return Number(raw);
}

function useCopyVariant(): number {
  const pinned = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("copy");
    if (raw === "0" || raw === "1" || raw === "2") return Number(raw);
    return null;
  }, []);
  const [variant, setVariant] = useState(pinned ?? 0);
  useEffect(() => {
    if (pinned != null) return;
    const id = window.setInterval(() => setVariant((current) => (current + 1) % 3), 4_000);
    return () => window.clearInterval(id);
  }, [pinned]);
  return variant;
}

function calmMotion(): boolean {
  if (readStill()) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function FlameIcon() {
  return (
    <svg className="flame" width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8.5V12l2.5 1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function whole(cents: number): string {
  return `$${dollars(cents).toLocaleString("en-US")}`;
}

function StatValue({ value, className = "stat-value" }: { value: string; className?: string }) {
  const seen = useRef<string | null>(null);
  const [fade, setFade] = useState(false);
  useEffect(() => {
    if (seen.current == null) {
      seen.current = value;
      return;
    }
    if (seen.current === value) return;
    seen.current = value;
    setFade(true);
  }, [value]);
  return (
    <strong className={`${className}${fade ? " changed" : ""}`} onAnimationEnd={() => setFade(false)}>
      {value}
    </strong>
  );
}

function StatRow({
  label,
  value,
  note,
  index,
  calm,
  bar,
  onNote,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  index: number;
  calm: boolean;
  bar?: ReactNode;
  onNote?: () => void;
}) {
  return (
    <motion.div
      className="stat"
      initial={calm ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut", delay: calm ? 0 : index * 0.03 }}
    >
      <span className="stat-label">{label}</span>
      {bar}
      {typeof value === "string" ? <StatValue value={value} /> : value}
      {note ? (
        onNote ? (
          <button type="button" className="stat-note" onClick={onNote}>
            {note}
          </button>
        ) : (
          <span className="stat-note">{note}</span>
        )
      ) : null}
    </motion.div>
  );
}

function splitWidths(collected: number, needed: number, covered: boolean): { green: number; red: number } {
  const green = weekFillPct(collected, Math.max(0, collected) + Math.max(0, needed), covered);
  const red = covered || green >= 100 ? 0 : 100 - green;
  return { green, red };
}

function signedMoney(cents: number, sign: "+" | "−"): string {
  const rounded = Math.abs(dollars(cents)).toLocaleString("en-US");
  return `${sign}$${rounded}.00`;
}

function UpgradeBar({
  level,
  next,
  progress,
  calm,
}: {
  level: number;
  next: number | null;
  progress: number;
  calm: boolean;
}) {
  return (
    <motion.div
      className={`upgrade${calm ? " calm" : " live"}`}
      initial={calm ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut", delay: calm ? 0 : 0.03 }}
    >
      <span className="gold-wrap">
        <span className="gold-bar" aria-hidden>
          <i style={{ width: `${progress}%`, transition: calm ? "none" : undefined }} />
        </span>
      </span>
      <span className="level-row">
        <span className="level-now">Level {level}</span>
        {next != null && <span className="level-next">Level {next}</span>}
      </span>
    </motion.div>
  );
}

function PresenceWeek({ presence }: { presence: PresenceView }) {
  return (
    <span className="presence-menu-week" aria-label="Week from the punch record">
      <i style={{ width: `${Math.round(presence.week.filledPct * 100)}%` }} />
      <span className="presence-menu-days">
        {presence.week.days.map((day) => (
          <em key={day.date} className={day.worked ? "worked" : ""}>
            {day.label}
          </em>
        ))}
      </span>
    </span>
  );
}

function StreakRow({ days }: { days: number }) {
  const mark = streakMark(days);
  return (
    <span className={`streak-row${mark.count === 0 ? " cold" : ""}`}>
      <FlameIcon />
      <strong className="streak-count">{mark.count}</strong>
      <span className="streak-label">{mark.label}</span>
    </span>
  );
}

function GameMenu({
  fight,
  calm,
  live,
  pending,
  ready,
  youName,
  streakDays,
  presence,
  onClock,
  onSettings,
}: {
  fight: FightView | null;
  calm: boolean;
  live: boolean;
  pending: boolean;
  ready: boolean;
  youName: string | null;
  streakDays: number;
  presence: PresenceView | null;
  onClock: () => void;
  onSettings: () => void;
}) {
  const week = fight?.week ?? null;
  if (!week) return null;
  const filled = week.ownCents + week.cushionUsedCents;
  const step = menuLevel({
    weeksCovered: week.weeksCovered,
    filledCents: filled,
    targetCents: week.targetCents,
    covered: week.covered,
  });
  const clockTitle = live ? "Clock out" : youName || "Clock in";
  return (
    <div className="col">
      <div className="level-stack">
        <UpgradeBar level={step.level} next={step.next} progress={step.pct} calm={calm} />
        <StreakRow days={streakDays} />
        {presence && <PresenceWeek presence={presence} />}
      </div>
      <div className="tool-row">
        <button
          type="button"
          className={`mark ctrl${live ? "" : " out"}`}
          onClick={onClock}
          disabled={pending || !ready}
          title={clockTitle}
          aria-label={clockTitle}
        >
          <ClockIcon />
          <span className="tip">{clockTitle}</span>
        </button>
        <button type="button" className="gear dock" aria-label="Settings" onClick={onSettings}>
          <GearIcon />
        </button>
      </div>
    </div>
  );
}

function MenuTop({
  week,
  live,
  won,
  chips,
  pending,
  ready,
  youName,
  onToggle,
  onClose,
  onCollapse,
}: {
  week: WeekView;
  live: boolean;
  won: boolean;
  chips: string[];
  pending: boolean;
  ready: boolean;
  youName: string | null;
  onToggle: () => void;
  onClose: () => void;
  onCollapse: () => void;
}) {
  const filled = week.ownCents + week.cushionUsedCents;
  const widths = splitWidths(filled, week.remainingCents, week.covered);
  const work = menuWorkLine(week.covered, filled, week.targetCents);
  return (
    <div className={`strip menu-card ${live ? "live" : "idle"}${won ? " won" : ""}`} data-clock={live ? "in" : "out"}>
      <span className="chips" aria-hidden>
        {chips.map((color, index) => (
          <i key={index} style={live && !won ? { background: color } : undefined} />
        ))}
      </span>
      <div className="ctrl-row">
        <button
          type="button"
          className="mark ctrl"
          onClick={onToggle}
          disabled={pending || !ready}
          title={live ? "Clock out" : youName || "Clock in"}
        >
          I/O
          <span className="tip">{live ? "Clock out" : youName || "Clock in"}</span>
        </button>
        <span className={`fight-cta${won ? " won" : ""}`}>{work}</span>
        <span className="actions">
          <button type="button" className="plus ctrl" onClick={onClose} aria-label="More">
            +
          </button>
          <button type="button" className="fold ctrl" onClick={onCollapse} aria-label="Collapse">
            ‹
          </button>
        </span>
      </div>
      <span className={`balance-bar${won ? " won" : ""}`} aria-hidden>
        {widths.green > 0 && <i className="in" style={{ width: `${widths.green}%` }} />}
        {widths.red > 0 && <i className="out" style={{ width: `${widths.red}%` }} />}
      </span>
      <span className="nums">
        <span className="num up">{signedMoney(week.ownCents, "+")}</span>
        <span className="num down">{signedMoney(week.remainingCents, "−")}</span>
      </span>
    </div>
  );
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
  const [settings, setSettings] = useState(() => readPanel() === "settings");
  const calm = useMemo(calmMotion, []);
  const [levelsOpen, setLevelsOpen] = useState(() => readPanel() === "levels");
  const [checklistOpen, setChecklistOpen] = useState(() => readPanel() === "checklist");
  const [news, setNews] = useState(() => readPanel() === "news");
  const bundled = useMemo(() => releaseNotes(), []);
  const [version, setVersion] = useState(bundled.version);
  const [notice, setNotice] = useState(bundled.notice);
  const [entries, setEntries] = useState<ReleaseNote[]>(bundled.entries);
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
  const [weekPreset] = useState<WeekPreset | null>(readWeek);
  const copyVariant = useCopyVariant();
  const [pinOpen, setPinOpen] = useState(false);
  const [afterPin, setAfterPin] = useState<"clock" | "settings" | "change" | null>(null);
  const heard = useRef(new Set<string>());
  const wasCleared = useRef<boolean | null>(null);
  const demo = demoScene ? demoModel(demoScene, weekPreset) : null;
  useEffect(() => {
    if (demoScene) return;
    void fetch(apiUrl("/api/changelog"), { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { version?: string; notice?: string; entries?: ReleaseNote[] };
        if (body.version) setVersion(body.version);
        if (body.notice) setNotice(body.notice);
        if (Array.isArray(body.entries) && body.entries.length) setEntries(body.entries);
      })
      .catch(() => undefined);
  }, [demoScene]);

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

  const rawFight = demo?.view ?? state?.fight ?? null;
  const fight = rawFight && weekPreset && !demo ? { ...rawFight, week: demoWeek(weekPreset, rawFight.date) } : rawFight;
  const ops = demo ? demoOps(demo.scene) : (state?.ops ?? null);
  const pinSet = state?.fight.pinSet ?? false;

  useEffect(() => {
    if (demo) return;
    if (!fight?.week.covered) {
      wasCleared.current = fight ? false : wasCleared.current;
      return;
    }
    if (wasCleared.current !== false) {
      wasCleared.current = true;
      return;
    }
    wasCleared.current = true;
    const key = `io.cleared.${fight.week.weekStart}`;
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
  const week = fight?.week ?? null;
  const workedOverride = demo ? readWorked() : null;
  const presence = demo ? null : (state?.presence ?? null);
  const streakDays = demo
    ? (workedOverride ??
      (fight
        ? shownWorkedDays(fight.workedDays, fight.todayWorked, live, isOpenKey(fight.date, fight.settings.openWeekdays))
        : 0))
    : (presence?.streakDays ?? 0);
  const won = Boolean(week?.covered && live);
  const barPct = week ? Math.min(100, week.barPct * 100) : 0;
  const headline = week ? weekLine(week, copyVariant) : "";
  const wide = (menu || settings || levelsOpen || checklistOpen || change || whoOpen || pinOpen) && !collapsed;
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
      ? fetch(apiUrl("/api/company/join"), {
          method: "POST",
          headers: ownerHeaders(),
          body: JSON.stringify({ code }),
        })
      : fetch(apiUrl("/api/company"), { headers: ownerHeaders() });
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
    const res = await fetch(apiUrl(path), {
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
    const res = await fetch(apiUrl(path), {
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
    const res = await fetch(apiUrl("/api/company/who"), { headers: authHeaders() });
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
        <button type="button" className="whats-new" onClick={() => setNews((open) => !open)}>
          I/O {version} · {notice}
        </button>
        {news && (
          <section className="news-panel" aria-label="What's new">
            <header>
              <h2>What's new</h2>
              <button type="button" onClick={() => setNews(false)} aria-label="Close what's new">
                Close
              </button>
            </header>
            {entries.map((entry) => (
              <div key={entry.version}>
                <p>{entry.version}</p>
                <ul>
                  {entry.bullets.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
        <PrintTape
          events={demo ? (demoHit ? [demoHit] : []) : freshEvents}
          onDone={dismissTick}
          hold={Boolean(demo)}
        />
        {presence && presence.dots.length > 0 && (
          <div className="presence-pips" aria-label="Who is in">
            {presence.dots.map((dot) => (
              <i key={dot.personId} className={dot.present ? "on" : "off"} title={`${dot.name} · ${dot.label}`} />
            ))}
          </div>
        )}

        {menu && !settings && week ? (
          <MenuTop
            week={week}
            live={live}
            won={won}
            chips={chips}
            pending={pending}
            ready={Boolean(state) || Boolean(demo)}
            youName={youName}
            onToggle={toggle}
            onClose={() => setMenu(false)}
            onCollapse={() => {
              setCollapsed(true);
              setMenu(false);
              setSettings(false);
              setChange(false);
              setWhoOpen(false);
              setPinOpen(false);
            }}
          />
        ) : (
        <div
          className={`strip ${live ? "live" : "idle"}${won ? " won" : ""}${collapsed ? " collapsed" : ""}${wide ? " with-panel" : ""}`}
          data-clock={live ? "in" : "out"}
          data-fight={won ? "cleared" : "behind"}
          data-week={week?.state ?? "bank"}
        >
          <span className="chips" aria-hidden>
            {chips.map((color, index) => (
              <i key={index} style={live && !won ? { background: color } : undefined} />
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
            {!collapsed && (
              <span className={`fight-cta${won ? " won" : ""}`} data-cta={headline}>
                {headline}
              </span>
            )}
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
            <span className={`balance-bar${won ? " won" : ""}`} aria-hidden>
              {barPct > 0 && <i className="in" style={{ width: `${barPct}%` }} />}
            </span>
          )}
          {!collapsed && week && (
            <span className="nums">
              <span className="num up">This week ${dollars(week.ownCents).toLocaleString("en-US")}</span>
              <span className={`num ${week.overCents > 0 ? "up" : "down"}`}>
                {week.overCents > 0
                  ? `+$${dollars(week.overCents).toLocaleString("en-US")} over`
                  : `Left $${dollars(week.remainingCents).toLocaleString("en-US")}`}
              </span>
            </span>
          )}
        </div>
        )}

        <AnimatePresence>
          {(menu || settings) && (
            <motion.div
              className="menu game"
              initial={calm ? false : { opacity: 0, scaleY: 0.92 }}
              animate={{ opacity: 1, scaleY: 1 }}
              exit={{ opacity: 0, scaleY: 0.92 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ transformOrigin: "top right" }}
            >
              {settings ? (
                <GearScreen
                  fight={fight}
                  ops={ops}
                  calm={calm}
                  demo={Boolean(demo)}
                  error={settingsError}
                  onBack={() => {
                    setSettings(false);
                    setMenu(true);
                  }}
                  onFight={async (path, body) => {
                    if (demo) return;
                    try {
                      await saveFight(path, body);
                    } catch (err) {
                      setSettingsError(err instanceof Error ? err.message : "Couldn't save that");
                      throw err;
                    }
                  }}
                />
              ) : (
                <GameMenu
                  fight={fight}
                  calm={calm}
                  live={live}
                  pending={pending}
                  ready={Boolean(state) || Boolean(demo)}
                  youName={youName}
                  streakDays={streakDays}
                  presence={presence}
                  onClock={toggle}
                  onSettings={() => {
                    if (!demo && !guard("settings")) return;
                    setSettings(true);
                  }}
                />
              )}
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
          {checklistOpen && (
            <ChecklistPanel demo={Boolean(demo)} onClose={() => setChecklistOpen(false)} />
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
        {error && !menu && !demo && <div className="err">{error}</div>}
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

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14.5 6.5 9 12l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MoneyEdit({
  cents,
  label,
  onCommit,
}: {
  cents: number;
  label: string;
  onCommit: (cents: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(cents / 100));
  if (!editing) {
    return (
      <button
        type="button"
        className="stat-value"
        onClick={() => {
          setDraft(String(cents / 100));
          setEditing(true);
        }}
      >
        {whole(cents)}
      </button>
    );
  }
  return (
    <input
      className="stat-value"
      value={draft}
      autoFocus
      inputMode="decimal"
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = Math.round(Number(draft) * 100);
        if (Number.isFinite(next) && next >= 0) onCommit(next);
      }}
    />
  );
}

function GearScreen({
  fight,
  ops,
  calm,
  demo,
  error,
  onBack,
  onFight,
}: {
  fight: FightView | null;
  ops: OpsView | null;
  calm: boolean;
  demo: boolean;
  error: string | null;
  onBack: () => void;
  onFight: (path: string, body: unknown) => Promise<void>;
}) {
  const settings = fight?.settings ?? DEFAULT_FIGHT_SETTINGS;
  const rewards = ops?.rules.table ?? [];
  const [editingLevels, setEditingLevels] = useState(false);
  const [rows, setRows] = useState(rewards.map((row) => ({ level: String(row.level), reward: row.reward })));
  const [pin, setPin] = useState("");
  const first = rewards[0]?.reward ?? "None";
  const rest = rewards
    .slice(1)
    .map((row) => row.reward)
    .join(" · ");

  const saveSettings = (patch: Partial<FightSettings>) => {
    if (demo) return;
    void onFight("/api/fight/settings", {
      ...settings,
      openWeekdays: [...settings.openWeekdays],
      ...patch,
    });
  };

  const saveLevels = (next = rows) => {
    if (demo) return;
    const table = next
      .map((row) => ({ level: Math.round(Number(row.level)), reward: row.reward.trim() }))
      .filter((row) => row.reward.length > 0 && Number.isFinite(row.level));
    if (table.length === 0) return;
    void onFight("/api/fight/levels", {
      clearsInARow: ops?.rules.clearsInARow ?? 5,
      table,
    });
  };

  return (
    <>
      <button type="button" className="gear" aria-label="Back" onClick={onBack}>
        <BackIcon />
      </button>
      <div className="col">
        <StatRow
          label="Settings"
          index={0}
          calm={calm}
          note="Week target"
          value={
            <MoneyEdit
              cents={settings.weeklyTargetCents}
              label="Weekly target"
              onCommit={(weeklyTargetCents) => saveSettings({ weeklyTargetCents })}
            />
          }
        />
        <StatRow
          label="PIN"
          index={1}
          calm={calm}
          note="Shop lock"
          value={
            fight?.pinSet ? (
              "On"
            ) : (
              <input
                className="stat-value"
                value={pin}
                placeholder="Set"
                aria-label="Shop PIN"
                inputMode="numeric"
                autoComplete="off"
                type="password"
                onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
                onBlur={() => {
                  if (!/^\d{4,8}$/.test(pin) || demo) return;
                  void onFight("/api/fight/pin", { pin });
                }}
              />
            )
          }
        />
        {editingLevels ? (
          rows.map((row, index) => (
            <StatRow
              key={`${row.level}-${index}`}
              label={`Lv ${row.level}`}
              index={2 + index}
              calm={calm}
              value={
                <input
                  className="stat-value"
                  value={row.reward}
                  aria-label={`Level ${row.level} reward`}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item, i) => (i === index ? { ...item, reward: event.target.value } : item)),
                    )
                  }
                  onBlur={() => saveLevels()}
                />
              }
            />
          ))
        ) : (
          <StatRow
            label="Levels"
            index={2}
            calm={calm}
            note={rest || undefined}
            value={
              <button type="button" className="stat-value" onClick={() => setEditingLevels(true)}>
                {first}
              </button>
            }
          />
        )}
        <StatRow
          label="Rent"
          index={editingLevels ? 2 + rows.length : 3}
          calm={calm}
          note={settings.rentEntered ? "Included" : "Not included"}
          onNote={
            demo
              ? undefined
              : () => saveSettings({ rentEntered: !settings.rentEntered })
          }
          value={
            <MoneyEdit
              cents={settings.rentMonthlyCents}
              label="Rent per month"
              onCommit={(rentMonthlyCents) => saveSettings({ rentMonthlyCents })}
            />
          }
        />
        {error ? <span className="stat-note">{error}</span> : null}
      </div>
    </>
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
    void fetch(apiUrl("/api/company/roster"), { headers: ownerHeaders() })
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
    const res = await fetch(apiUrl(`/api/company/people/${id}`), {
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
    const res = await fetch(apiUrl("/api/company/people"), {
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
      reward: row.reward,
    })),
  );
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const table = rows
      .map((row) => ({
        level: Math.round(Number(row.level)),
        reward: row.reward.trim(),
      }))
      .filter((row) => row.reward.length > 0);
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
      <p className="menu-note">Clear open days in a row. Unlocks are team rewards, not money.</p>
      <div className="menu-row">
        <span>Weeks in a row</span>
        <span>{ops.weekStreak}</span>
      </div>
      <label className="settings-line">
        <span>Days</span>
        <input value={days} onChange={(event) => setDays(event.target.value)} inputMode="numeric" aria-label="Open days in a row" />
      </label>
      {rows.map((row, index) => (
        <div className="level-grid" key={index}>
          <input
            value={row.level}
            aria-label={`Unlock ${index + 1} level`}
            inputMode="numeric"
            onChange={(event) =>
              setRows((current) => current.map((item, i) => (i === index ? { ...item, level: event.target.value } : item)))
            }
          />
          <input
            value={row.reward}
            aria-label={`Level ${row.level} reward`}
            onChange={(event) =>
              setRows((current) => current.map((item, i) => (i === index ? { ...item, reward: event.target.value } : item)))
            }
          />
        </div>
      ))}
      <div className="menu-actions">
        <button
          type="button"
          onClick={() =>
            setRows((current) => {
              const last = Number(current[current.length - 1]?.level);
              const level = Number.isFinite(last) ? String(last + 1) : String(current.length + 1);
              return [...current, { level, reward: "" }];
            })
          }
        >
          Add
        </button>
      </div>
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

function ChecklistPanel({ demo, onClose }: { demo: boolean; onClose: () => void }) {
  const [checks, setChecks] = useState<ReadinessCheck[]>(() => (demo ? demoReadiness().checks : []));
  const [scope, setScope] = useState<string>(demo ? "local" : "");
  const [ready, setReady] = useState(demo ? demoReadiness().ready : false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (demo) return;
    let cancel = false;
    void fetch(apiUrl("/api/health"))
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
          <span>{check.ok ? check.note || "Yes" : check.detail}</span>
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
