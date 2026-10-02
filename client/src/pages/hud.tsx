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

export default function Hud() {
  const {
    state,
    error,
    pending,
    freshEvents,
    dismissTick,
    clockIn,
    clockOut,
    recordInput,
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
  const rate = state ? state.config.hourlyOutputCents / 100 : 20;

  // Efficiency: output dollars per hour of input time (live mark).
  const efficiency =
    inputMs > 0 ? output / 100 / (inputMs / 3_600_000) : live ? rate : 0;

  useEffect(() => {
    const latest = state?.events[0];
    if (!latest) return;
    if (latest.kind === "hour_print") {
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
      <div className="strip-anchor">
        <PrintTape events={freshEvents} onDone={dismissTick} />

        <div className={`strip ${live ? "live" : "idle"}`} role="group" aria-label="I/O terminal">
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
            <span className="swatch" aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </span>
          </button>

          <button
            type="button"
            className={`cell ${flashI ? "flash-up" : ""}`}
            onClick={toggle}
            disabled={pending || !state}
          >
            <span className="k">I</span>
            <span className="v in">{clock(inputMs)}</span>
          </button>

          <div className="sep" />

          <button
            type="button"
            className={`cell primary ${flashO ? "flash-up" : ""}`}
            onClick={toggle}
            disabled={pending || !state}
          >
            <span className="k">O</span>
            <span className="v out">
              {output >= 0 ? "+" : ""}
              {money(output)}
            </span>
          </button>

          {live && (
            <>
              <div className="sep" />
              <div className="cell thin">
                <span className="k">NX</span>
                <span className="v dim">{countdown(state?.msToNextPrint ?? 0)}</span>
              </div>
            </>
          )}

          <button
            type="button"
            className="menu-btn"
            onClick={() => setMenu((m) => !m)}
            aria-label="More"
          >
            +
          </button>

          {live && (
            <div className="rail">
              <motion.div
                className="rail-fill"
                animate={{
                  width: `${
                    state
                      ? Math.min(
                          100,
                          ((state.config.hourDurationMs - state.msToNextPrint) /
                            state.config.hourDurationMs) *
                            100,
                        )
                      : 0
                  }%`,
                }}
                transition={{ duration: 0.15, ease: "linear" }}
              />
            </div>
          )}
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
              <div className="menu-row">
                <span className="k">I.U</span>
                <span className={`v in ${flashI ? "flash-up" : ""}`}>{inputUnits}</span>
                <span className="k">$/HR</span>
                <span className="v out">{efficiency.toFixed(0)}</span>
              </div>
              <div className="menu-actions">
                <button type="button" disabled={pending} onClick={() => recordInput("prompt")}>
                  I+3
                </button>
                <button type="button" disabled={pending} onClick={() => recordInput("email")}>
                  I+2
                </button>
                <button type="button" disabled={pending} onClick={() => reset()}>
                  CLR
                </button>
                <button type="button" disabled={pending || !state} onClick={toggle}>
                  {live ? "OUT" : "IN"}
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
  const point = event.kind === "input";
  const big = (event.kind === "hour_print" || event.kind === "sale") && event.outputCents >= 2000;
  const isOut = event.outputCents > 0;

  useEffect(() => {
    const life = big ? 2400 : point ? 1800 : 1400;
    const t = setTimeout(() => onDone(event.id), life);
    return () => clearTimeout(t);
  }, [event.id, big, point, onDone]);

  const rank = point ? "point" : isOut ? "out" : "in";

  return (
    <motion.div
      className={`print ${rank}${big ? " big" : ""}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: -offset * 6 }}
      exit={{ opacity: 0, y: -18 }}
      transition={{ duration: 0.08 }}
    >
      {event.label}
    </motion.div>
  );
}
