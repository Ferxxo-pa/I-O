import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useIoState } from "@/hooks/useEarnState";
import { ching, unlockChing } from "@/lib/ching";
import { signedMoney, type BookFlash } from "@shared/book";
import type { CompanyState } from "@shared/schema";

function money(cents: number): string {
  const n = cents / 100;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-${abs}` : abs;
}

function rateText(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return String(dollars);
  return dollars.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export default function Hud() {
  const { state, error, pending, clockIn, clockOut } = useIoState();
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [company, setCompany] = useState<CompanyState | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [pops, setPops] = useState<BookFlash[]>([]);
  const seenFlashes = useRef(new Set<string>());
  const flashesReady = useRef(false);

  useEffect(() => {
    const unlock = () => unlockChing();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  const book = state?.book;
  const balanceCents = book?.balanceCents ?? 0;
  const shown = signedMoney(balanceCents);

  useEffect(() => {
    const flashes = book?.flashes ?? [];
    if (!flashesReady.current) {
      flashes.forEach((flash) => seenFlashes.current.add(flash.id));
      flashesReady.current = true;
      return;
    }
    const fresh = flashes.filter((flash) => !seenFlashes.current.has(flash.id));
    fresh.forEach((flash) => seenFlashes.current.add(flash.id));
    if (!fresh.length) return;
    fresh.forEach((flash) => {
      if (flash.label.startsWith("+")) ching();
    });
    setPops((prev) => [...fresh, ...prev].slice(0, 4));
  }, [book?.flashes]);

  const live = state?.session.clockedIn ?? false;
  const paycheck = (state?.session.outputCents ?? 0) + (state?.accruedOutputCents ?? 0);
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const wide = (menu || settings) && !collapsed;

  useEffect(() => {
    let cancel = false;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("join");
    const load = code
      ? fetch("/api/company/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        })
      : fetch("/api/company");
    void load
      .then(async (res) => {
        const next = await res.json();
        if (!res.ok) throw new Error(next.message || "Couldn't load settings");
        if (cancel) return;
        setCompany(next);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const next = await res.json();
    if (!res.ok) throw new Error(next.message || "Couldn't save that");
    setCompany(next);
  };

  return (
    <div className="stage">
      <div className="strip-anchor">
        <PrintTape flashes={pops} onDone={(id) => setPops((prev) => prev.filter((flash) => flash.id !== id))} />

        <div
          className={`strip ${live ? "live" : "idle"}${collapsed ? " collapsed" : ""}${wide ? " with-panel" : ""}`}
        >
          <span className="mark">
            I/O
            <span className="dot" />
          </span>
          {!collapsed && (
            <motion.span
              key={balanceCents}
              className={`num${balanceCents > 0 ? " up" : balanceCents < 0 ? " down" : ""}`}
              initial={{ opacity: 0.35, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28 }}
            >
              {shown}
            </motion.span>
          )}
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
          {!collapsed && (
            <span
              className={`balance-bar${book?.tie ? " tie" : ""}${book?.neutral !== false ? " neutral" : ""}`}
              aria-label={
                book && !book.neutral
                  ? `Plus ${Math.round(book.green)} percent, minus ${Math.round(book.red)} percent`
                  : "No money in or out today"
              }
            >
              {book && !book.neutral && (
                <>
                  <i className="in" style={{ width: `${book.green}%` }} />
                  <i className="out" style={{ width: `${book.red}%` }} />
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
                <span>Pay</span>
                <span>${money(paycheck)}</span>
              </div>
              <div className="menu-row">
                <span>Rate</span>
                <span>${rateText(rateCents)}/hr</span>
              </div>
              <div className="menu-actions">
                <button
                  type="button"
                  disabled={pending || !state}
                  onClick={() => {
                    if (live) clockOut();
                    else clockIn();
                  }}
                >
                  {live ? "Clock out" : "Clock in"}
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

function SettingsPanel({
  company,
  rate,
  telegram,
  error,
  onClose,
  onSave,
}: {
  company: CompanyState | null;
  rate: string;
  telegram: string | null;
  error: string | null;
  onClose: () => void;
  onSave: (path: string, body: unknown) => Promise<void>;
}) {
  const [handle, setHandle] = useState("");
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

      <p className="settings-rate">${rate}/hr</p>

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

function PrintTape({ flashes, onDone }: { flashes: BookFlash[]; onDone: (id: string) => void }) {
  return (
    <div className="tape">
      <AnimatePresence>
        {flashes.map((flash) => (
          <TapePrint key={flash.id} flash={flash} onDone={onDone} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function TapePrint({ flash, onDone }: { flash: BookFlash; onDone: (id: string) => void }) {
  const minus = flash.label.startsWith("−");

  useEffect(() => {
    const t = setTimeout(() => onDone(flash.id), 1600);
    return () => clearTimeout(t);
  }, [flash.id, onDone]);

  return (
    <motion.div
      className={`print ${minus ? "down" : "up"}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.16 }}
    >
      {flash.label}
    </motion.div>
  );
}
