import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useIoState } from "@/hooks/useEarnState";
import type { PrintEvent } from "@shared/schema";

function money(cents: number): string {
  const n = cents / 100;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-${abs}` : abs;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function rateText(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return String(dollars);
  return dollars.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Revenue stepped once a second so the total ticks like a clock. */
function tickedRevenue(state: {
  session: { clockedIn: boolean; outputCents: number };
  config: { hourlyOutputCents: number; hourDurationMs: number };
  accruedOutputCents: number;
  msToNextPrint: number;
} | null): number {
  if (!state) return 0;
  const printed = state.session.outputCents;
  if (!state.session.clockedIn) return printed;
  const hour = state.config.hourDurationMs;
  const elapsed = Math.max(0, hour - state.msToNextPrint);
  const seconds = Math.floor(elapsed / 1000);
  const perSecond = state.config.hourlyOutputCents / (hour / 1000);
  const stepped = Math.min(state.config.hourlyOutputCents, Math.floor(seconds * perSecond));
  return printed + stepped;
}

export default function Hud() {
  const {
    state,
    error,
    pending,
    freshEvents,
    dismissTick,
    clockIn,
    clockOut,
    reset,
  } = useIoState();

  const [menu, setMenu] = useState(false);
  const [wash, setWash] = useState<"in" | "sale" | "point" | null>(null);
  const [tick, setTick] = useState<{ id: number; label: string } | null>(null);
  const seenRevenue = useRef<number | null>(null);
  const wasLive = useRef(false);

  const live = state?.session.clockedIn ?? false;
  const revenue = tickedRevenue(state);
  const inputMs = state?.inputMs ?? 0;
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const squareOn = state?.square.connected ?? false;

  useEffect(() => {
    if (live && !wasLive.current) setWash("in");
    wasLive.current = live;
  }, [live]);

  useEffect(() => {
    const latest = state?.events[0];
    if (!latest) return;
    if (latest.kind === "sale" || latest.kind === "hour_print") setWash("sale");
    else if (latest.kind === "input") setWash("point");
  }, [state?.events[0]?.id]);

  useEffect(() => {
    if (!wash) return;
    const life = wash === "sale" ? 720 : 560;
    const t = setTimeout(() => setWash(null), life);
    return () => clearTimeout(t);
  }, [wash]);

  useEffect(() => {
    if (seenRevenue.current === null) {
      seenRevenue.current = revenue;
      return;
    }
    const delta = revenue - seenRevenue.current;
    seenRevenue.current = revenue;
    if (!live || delta <= 0) return;
    const id = Date.now();
    setTick({ id, label: `+${money(delta)}` });
    const t = setTimeout(() => setTick((current) => (current?.id === id ? null : current)), 700);
    return () => clearTimeout(t);
  }, [revenue, live]);

  const toggle = () => {
    if (pending || !state) return;
    if (live) clockOut();
    else clockIn();
  };

  return (
    <div className={`stage ${live ? "live" : "idle"}${wash ? ` wash-${wash}` : ""}`}>
      <div className="crt" aria-hidden />

      <div className="strip-anchor">
        <PrintTape events={freshEvents} onDone={dismissTick} />

        <div className={`strip ${live ? "live" : "idle"}`} role="group" aria-label="I/O">
          <button
            type="button"
            className="mark"
            onClick={toggle}
            disabled={pending || !state}
            title={live ? "Clock out" : "Clock in"}
          >
            <span className="mark-name">
              <span className="mark-i">I</span>
              <span className="mark-slash">/</span>
              <span className="mark-o">O</span>
            </span>
            <span className={`dot ${live ? "on" : ""}`} />
          </button>

          <div className="sep" />

          <div className="cell revenue" title="Revenue this shift">
            <AnimatePresence>
              {tick && (
                <motion.div
                  key={tick.id}
                  className="tick-pop"
                  initial={{ opacity: 0, y: 8, scale: 0.45, x: "-50%" }}
                  animate={{ opacity: 1, y: -20, scale: 1.05, x: "-50%" }}
                  exit={{ opacity: 0, y: -38, scale: 0.9, x: "-50%" }}
                  transition={{ type: "spring", stiffness: 680, damping: 16 }}
                >
                  {tick.label}
                </motion.div>
              )}
            </AnimatePresence>
            <motion.span
              key={live ? revenue : "idle"}
              className="v out"
              initial={live ? { scale: 1.38, y: 2 } : false}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 700, damping: 12 }}
            >
              {revenue >= 0 ? "+" : ""}
              {money(revenue)}
            </motion.span>
          </div>

          <button
            type="button"
            className="menu-btn"
            onClick={() => setMenu((m) => !m)}
            aria-label="More"
          >
            +
          </button>

        </div>

        <AnimatePresence>
          {menu && (
            <motion.div
              className="menu"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.12 }}
            >
              <div className="detail">
                <span className="k">TIME</span>
                <span className="v in">{clock(inputMs)}</span>
              </div>
              <div className="detail">
                <span className="k">MONEY</span>
                <span className="v out">
                  {revenue >= 0 ? "+" : ""}
                  {money(revenue)}
                </span>
              </div>
              <div className="detail">
                <span className="k">$/HR</span>
                <span className="v dim">{rateText(rateCents)}</span>
              </div>
              {live && (
                <div className="detail">
                  <span className="k">NEXT</span>
                  <span className="v dim">{countdown(state?.msToNextPrint ?? 0)}</span>
                </div>
              )}
              <div className="hint">
                {squareOn ? "Rate from Square." : "Demo rate until Square is connected."}
              </div>
              <div className="menu-actions">
                <button type="button" disabled={pending} onClick={() => reset()}>
                  Reset
                </button>
                <button type="button" disabled={pending || !state} onClick={toggle}>
                  {live ? "Clock out" : "Clock in"}
                </button>
              </div>
              {error && <div className="err">{error}</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
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
        {events.map((event, i) => (
          <TapePrint key={event.id} event={event} offset={i} onDone={onDone} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function TapePrint({
  event,
  offset,
  onDone,
}: {
  event: PrintEvent;
  offset: number;
  onDone: (id: string) => void;
}) {
  const big =
    (event.kind === "hour_print" || event.kind === "sale") && event.outputCents >= 2000;
  const point = event.kind === "input";

  useEffect(() => {
    const life = big ? 4200 : point ? 2400 : 1800;
    const t = setTimeout(() => onDone(event.id), life);
    return () => clearTimeout(t);
  }, [event.id, big, point, onDone]);

  const isOut = event.outputCents > 0;

  return (
    <motion.div
      className={`print ${isOut ? "out" : "in"} ${big ? "big" : ""}`}
      initial={{ opacity: 0, y: 18, scale: 0.35 }}
      animate={{ opacity: 1, y: -10 - offset * 8, scale: big ? 1.4 : point ? 1.22 : 1.05 }}
      exit={{ opacity: 0, y: -46, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 680, damping: 14 }}
    >
      {event.label}
    </motion.div>
  );
}
