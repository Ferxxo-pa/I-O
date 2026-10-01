import { useEffect } from "react";
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
  const { state, error, pending, freshEvents, dismissTick, clockIn, clockOut } = useIoState();

  const live = state?.session.clockedIn ?? false;
  const revenue = tickedRevenue(state);
  const shown = revenue < 0 ? dollars(revenue) : `+${dollars(revenue)}`;

  const toggle = () => {
    if (pending || !state) return;
    if (live) clockOut();
    else clockIn();
  };

  return (
    <div className={`term ${live ? "live" : "idle"}`}>
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
        </button>

        {error && <p className="err">{error}</p>}
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
