import { useEffect, useState } from "react";
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

function dollars(cents: number): string {
  const body = money(Math.abs(cents));
  return cents < 0 ? `-$${body}` : `$${body}`;
}

export default function Hud() {
  const { state, error, pending, freshEvents, dismissTick, clockIn, clockOut, reset } = useIoState();
  const [menu, setMenu] = useState(false);

  const live = state?.session.clockedIn ?? false;
  const revenue = tickedRevenue(state);
  const inputMs = state?.inputMs ?? 0;
  const rateCents = state?.config.hourlyOutputCents ?? 2000;
  const shown = revenue < 0 ? dollars(revenue) : `+${dollars(revenue)}`;

  const toggle = () => {
    if (pending || !state) return;
    if (live) clockOut();
    else clockIn();
  };

  return (
    <div className={`term ${live ? "live" : "idle"}`}>
      <button type="button" className="more" onClick={() => setMenu((open) => !open)} aria-expanded={menu}>
        {menu ? "Close" : "Details"}
      </button>

      <div className="session">
        <div className="log" aria-live="polite">
          {[...freshEvents].reverse().map((event) => (
            <TapeLine key={event.id} event={event} onDone={dismissTick} />
          ))}
        </div>

        <button
          type="button"
          className="prompt"
          onClick={toggle}
          disabled={pending || !state}
          title={live ? "Clock out" : "Clock in"}
        >
          <span className="now" key={live ? shown : "out"}>
            {live ? shown : "Clock in"}
          </span>
          <span className="cursor" />
        </button>

        {menu && (
          <div className="details">
            <div className="meta">
              <span>Time</span>
              <span>{clock(inputMs)}</span>
            </div>
            <div className="meta">
              <span>Rate</span>
              <span className="money">${rateText(rateCents)}/hr</span>
            </div>
            {live && (
              <div className="meta">
                <span>Next hour</span>
                <span>{countdown(state?.msToNextPrint ?? 0)}</span>
              </div>
            )}
            <div className="cmds">
              <button type="button" disabled={pending} onClick={() => reset()}>
                Reset
              </button>
            </div>
            {error && <p className="err">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function TapeLine({ event, onDone }: { event: PrintEvent; onDone: (id: string) => void }) {
  const big = (event.kind === "hour_print" || event.kind === "sale") && event.outputCents >= 2000;
  const point = event.kind === "input";

  useEffect(() => {
    const life = big ? 5600 : point ? 4000 : 2400;
    const t = window.setTimeout(() => onDone(event.id), life);
    return () => window.clearTimeout(t);
  }, [event.id, big, point, onDone]);

  const rank = big ? "sale" : point ? "point" : "note";
  const text = point ? `+${event.inputUnits || 1}` : event.label;
  return <div className={`row ${rank}`}>{text}</div>;
}
