import { useEffect, useState } from "react";
import type { AppState } from "@shared/schema";
import type { PresenceDot, PresenceView } from "@shared/presence";
import { apiUrl } from "@/serverUrl";
import { authHeaders } from "@/hooks/useEarnState";

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
    let delay = 1000;
    let timer = 0;
    let controller: AbortController | null = null;
    const connect = async () => {
      controller = new AbortController();
      try {
        const res = await fetch(apiUrl("/api/live"), { headers: authHeaders(), signal: controller.signal });
        if (!res.ok || !res.body) throw new Error("Couldn't load presence");
        delay = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          let cut = buf.indexOf("\n\n");
          while (cut >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const line = block.split("\n").find((row) => row.startsWith("data: "));
            if (line && !stop) {
              const next = JSON.parse(line.slice(6)) as AppState;
              setView(next.presence);
              setError(null);
            }
            cut = buf.indexOf("\n\n");
          }
        }
        throw new Error("Couldn't load presence");
      } catch (err) {
        if (stop || (err instanceof DOMException && err.name === "AbortError")) return;
        if (!stop) setError(err instanceof Error ? err.message : "Couldn't load presence");
      }
      if (stop) return;
      timer = window.setTimeout(() => {
        void connect();
      }, delay);
      delay = Math.min(delay * 2, 15_000);
    };
    void connect();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      controller?.abort();
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
