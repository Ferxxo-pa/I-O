import { useEffect, useState } from "react";
import { motion } from "framer-motion";
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
  const { state, error, pending, freshEvents, dismissTick, clockIn, clockOut, reset } = useIoState();
  const [menu, setMenu] = useState(false);

  const live = state?.session.clockedIn ?? false;
  const revenue = tickedRevenue(state);
  const inputMs = state?.inputMs ?? 0;
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const squareOn = state?.square.connected ?? false;
  const shown = `${revenue >= 0 ? "+" : ""}${money(revenue)}`;

  const toggle = () => {
    if (pending || !state) return;
    if (live) clockOut();
    else clockIn();
  };

  return (
    <div className={`stage ${live ? "live" : "idle"}`}>
      <div className="deck">
        <div className="prints">
          <PrintTape events={freshEvents} onDone={dismissTick} />
        </div>

        <div className="box">
          <button
            type="button"
            className="face"
            onClick={toggle}
            disabled={pending || !state}
            title={live ? "Clock out" : "Clock in"}
          >
            <span className="mark">I/O</span>
            <span className="money">{shown}</span>
          </button>
          <button type="button" className="more" onClick={() => setMenu((open) => !open)} aria-label="More">
            {menu ? "–" : "+"}
          </button>

          {menu && (
            <div className="details">
              <div className="row">
                <span className="k">Time</span>
                <span className="v">{clock(inputMs)}</span>
              </div>
              <div className="row">
                <span className="k">Made</span>
                <span className="v">{shown}</span>
              </div>
              <div className="row">
                <span className="k">$/hr</span>
                <span className="v">{rateText(rateCents)}</span>
              </div>
              {live && (
                <div className="row">
                  <span className="k">Next</span>
                  <span className="v">{countdown(state?.msToNextPrint ?? 0)}</span>
                </div>
              )}
              <div className="hint">{squareOn ? "Rate from Square" : "Demo rate, until Square is on"}</div>
              <div className="cmds">
                <button type="button" className="cmd" disabled={pending || !state} onClick={toggle}>
                  {live ? "Out" : "In"}
                </button>
                <button type="button" className="cmd" disabled={pending} onClick={() => reset()}>
                  Reset
                </button>
              </div>
              {error && <div className="err">{error}</div>}
            </div>
          )}
        </div>
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
    <>
      {events.map((event) => (
        <TapePrint key={event.id} event={event} onDone={onDone} />
      ))}
    </>
  );
}

function TapePrint({ event, onDone }: { event: PrintEvent; onDone: (id: string) => void }) {
  const big = (event.kind === "hour_print" || event.kind === "sale") && event.outputCents >= 2000;
  const point = event.kind === "input";

  useEffect(() => {
    const life = big ? 4200 : point ? 2400 : 1800;
    const t = window.setTimeout(() => onDone(event.id), life);
    return () => window.clearTimeout(t);
  }, [event.id, big, point, onDone]);

  const rank = big ? "sale" : point ? "point" : "note";
  return (
    <motion.div
      className={`hit ${rank}`}
      initial={{ opacity: 0, scale: 0.72, y: 16 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 16 }}
    >
      {event.label}
    </motion.div>
  );
}
