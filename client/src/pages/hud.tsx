import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useIoState } from "@/hooks/useEarnState";
import type { PrintEvent } from "@shared/schema";

const HINT_KEY = "io-hint";

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
  const { state, error, pending, freshEvents, dismissTick, clockIn, clockOut, reset } = useIoState();
  const [menu, setMenu] = useState(false);
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) ?? "0";
    } catch {
      return "0";
    }
  });

  const live = state?.session.clockedIn ?? false;
  const output = (state?.session.outputCents ?? 0) + (state?.accruedOutputCents ?? 0);
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const shown = `$${money(Math.abs(output))}`;

  const mark = (next: string) => {
    setSeen(next);
    try {
      localStorage.setItem(HINT_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const toggle = () => {
    if (pending || !state) return;
    if (live) {
      if (seen !== "1") mark("1");
      clockOut();
    } else {
      if (seen === "0") mark("in");
      clockIn();
    }
  };

  const hint = seen === "1" ? null : live ? "out" : "in";

  return (
    <div className="stage">
      <div className="strip-anchor">
        <PrintTape events={freshEvents} onDone={dismissTick} />

        <div className={`strip ${live ? "live" : "idle"}`}>
          <button
            type="button"
            className="mark"
            onClick={toggle}
            disabled={pending || !state}
            title={live ? "Clock out" : "Clock in"}
          >
            I/O
            <span className="dot" />
          </button>
          <span className="num">{shown}</span>
          <button type="button" className="plus" onClick={() => setMenu((open) => !open)} aria-label="More">
            +
          </button>
          {hint && <div className="tip">{hint === "out" ? "Clock out" : "Clock in"}</div>}
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
                <span>Rate</span>
                <span>${rateText(rateCents)}/hr</span>
              </div>
              <button type="button" disabled={pending} onClick={() => reset()}>
                Reset
              </button>
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
        {events.map((event) => (
          <TapePrint key={event.id} event={event} onDone={onDone} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function TapePrint({ event, onDone }: { event: PrintEvent; onDone: (id: string) => void }) {
  const point = event.kind === "input";
  const big = (event.kind === "hour_print" || event.kind === "sale") && event.outputCents >= 2000;

  useEffect(() => {
    const life = big ? 2600 : point ? 1800 : 1400;
    const t = setTimeout(() => onDone(event.id), life);
    return () => clearTimeout(t);
  }, [event.id, big, point, onDone]);

  const text = point ? `+${event.inputUnits || 1}` : event.label;

  return (
    <motion.div
      className={`print${point ? " point" : ""}${big ? " big" : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.16 }}
    >
      {text}
    </motion.div>
  );
}
