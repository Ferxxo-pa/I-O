import { useEffect, useState } from "react";
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

  const [flashO, setFlashO] = useState(false);
  const [flashI, setFlashI] = useState(false);
  const [menu, setMenu] = useState(false);

  const live = state?.session.clockedIn ?? false;
  const output =
    (state?.session.outputCents ?? 0) + (state?.accruedOutputCents ?? 0);
  const inputMs = state?.inputMs ?? 0;
  const inputUnits = state?.session.inputUnits ?? 0;
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const squareOn = state?.square.connected ?? false;

  useEffect(() => {
    const latest = state?.events[0];
    if (!latest) return;
    if (latest.kind === "hour_print" || latest.kind === "sale") {
      setFlashO(true);
      const t = setTimeout(() => setFlashO(false), 280);
      return () => clearTimeout(t);
    }
    if (latest.kind === "input") {
      setFlashI(true);
      const t = setTimeout(() => setFlashI(false), 280);
      return () => clearTimeout(t);
    }
  }, [state?.events[0]?.id]);

  const toggle = () => {
    if (pending || !state) return;
    if (live) clockOut();
    else clockIn();
  };

  return (
    <div className="stage">
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

          <div className={`cell ${flashI ? "flash-up" : ""}`} title="Points for messages sent">
            <span className="k">PTS</span>
            <span className="v pts">{inputUnits}</span>
          </div>

          <div className="sep" />

          <div
            className={`cell primary ${flashO ? "flash-up" : ""}`}
            title={squareOn ? "What you make per hour, from Square" : "What you make per hour"}
          >
            <span className="k">$/HR</span>
            <span className="v out">{rateText(rateCents)}</span>
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
                <span className={`v out ${flashO ? "flash-up" : ""}`}>
                  {output >= 0 ? "+" : ""}
                  {money(output)}
                </span>
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
  useEffect(() => {
    const life = event.kind === "sale" ? 3200 : 1600;
    const t = setTimeout(() => onDone(event.id), life);
    return () => clearTimeout(t);
  }, [event.id, event.kind, onDone]);

  const big =
    (event.kind === "hour_print" || event.kind === "sale") && event.outputCents >= 2000;
  const isOut = event.outputCents > 0;

  return (
    <motion.div
      className={`print ${isOut ? "out" : "in"} ${big ? "big" : ""}`}
      initial={{ opacity: 0, y: 8, scale: 0.9 }}
      animate={{ opacity: 1, y: -4 - offset * 4, scale: big ? 1.15 : 1 }}
      exit={{ opacity: 0, y: -28 }}
      transition={{ type: "spring", stiffness: 420, damping: 24 }}
    >
      {event.label}
    </motion.div>
  );
}
