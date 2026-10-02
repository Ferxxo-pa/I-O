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

  const goIn = () => {
    if (pending || !state || live) return;
    if (seen === "0") mark("in");
    clockIn();
  };

  const goOut = () => {
    if (pending || !state || !live) return;
    if (seen !== "1") mark("1");
    clockOut();
  };

  const hint = seen === "1" ? null : live ? "out" : "in";

  return (
    <div className="stage">
      <div className="strip-anchor">
        <PrintTape events={freshEvents} onDone={dismissTick} />

        <div className={`strip ${live ? "live" : "idle"}`} role="group" aria-label="I/O">
          <button
            type="button"
            className="io out-btn"
            onClick={goOut}
            disabled={pending || !state || !live}
          >
            I
          </button>
          <button
            type="button"
            className="io in-btn"
            onClick={goIn}
            disabled={pending || !state || live}
          >
            O
          </button>
          <div className="sep" />
          <div className="cell">
            <span className="num">{live || output !== 0 ? shown : "$0.00"}</span>
          </div>
          <button type="button" className="plus" onClick={() => setMenu((open) => !open)} aria-label="More">
            +
          </button>

          {hint && (
            <div className={`tip ${hint === "out" ? "on-i" : "on-o"}`} role="note">
              {hint === "out" ? "Click I to clock out" : "Click O to clock in"}
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
                <span>Rate</span>
                <span className="num">${rateText(rateCents)}/hr</span>
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
  const rank = point ? "point" : big ? "big" : "out";

  return (
    <motion.div
      className={`print ${rank}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.08 }}
    >
      {text}
    </motion.div>
  );
}
