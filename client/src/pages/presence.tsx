import { useEffect, useState } from "react";
import type { PresenceDot, PresenceView } from "@shared/presence";
import { apiUrl } from "@/serverUrl";

function featured(view: PresenceView | null): PresenceDot | null {
  if (!view || view.dots.length === 0) return null;
  return (
    [...view.dots].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0)).find((dot) => dot.lastTs != null) ??
    view.dots[0]
  );
}

export default function PresencePage() {
  const [view, setView] = useState<PresenceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Presence · EZ Designs";
    let stop = false;
    const load = () => {
      void fetch(apiUrl("/api/presence"))
        .then(async (res) => {
          const body = (await res.json()) as PresenceView & { message?: string };
          if (!res.ok) throw new Error(body.message || "Couldn't load presence");
          if (!stop) {
            setView(body);
            setError(null);
          }
        })
        .catch((err) => {
          if (!stop) setError(err instanceof Error ? err.message : "Couldn't load presence");
        });
    };
    load();
    const id = window.setInterval(load, 1000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const dot = featured(view);
  const rejected = Boolean(dot?.lastMessage);
  const state = rejected ? "rejected" : (dot?.phase ?? "out");
  const title = rejected ? "Rejected punch" : (dot?.label ?? "Out");

  return (
    <div className="presence-stage">
      <a className="presence-home" href="/">
        I/O
      </a>
      <section className="presence-card" data-state={state} aria-live="polite">
        <div className="presence-kicker">
          <span>{view?.shop.label ?? "EZ Designs"}</span>
          <span>{view?.squareMode === "live" ? "Square live" : "Square dry run"}</span>
        </div>
        <p className="presence-address">{view?.shop.address ?? "403 E Ben White Blvd, Austin, TX"}</p>
        <div className={`presence-orb${dot?.present ? " on" : ""}`} aria-hidden />
        <h1>{title}</h1>
        <p className="presence-who">{dot ? dot.name : "Nobody on the roster yet"}</p>
        <p className="presence-detail">{rejected ? dot?.lastMessage : dot?.detail}</p>
        {rejected && dot?.present && <p className="presence-keep">Still {dot.label.toLowerCase()}. Nothing changed.</p>}
        <div className="presence-streak" data-count={view?.streakDays ?? 0}>
          <strong>{view?.streakDays ?? 0}</strong>
          <span>day streak</span>
        </div>
        <div className="presence-week" aria-label="Week from the punch record">
          <i style={{ width: `${Math.round((view?.week.filledPct ?? 0) * 100)}%` }} />
        </div>
        <div className="presence-days">
          {(view?.week.days ?? []).map((day) => (
            <span key={day.date} className={day.worked ? "worked" : day.open ? "open" : "off"}>
              {day.label}
            </span>
          ))}
        </div>
        <ul className="presence-dots">
          {(view?.dots ?? []).map((person) => (
            <li key={person.personId}>
              <i className={person.present ? "on" : "off"} />
              <span>{person.name}</span>
              <em>{person.label}</em>
            </li>
          ))}
        </ul>
        {error && <p className="presence-detail">{error}</p>}
      </section>
    </div>
  );
}
