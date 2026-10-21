import { spawn } from "node:child_process";
import { join } from "node:path";

const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds until the next clock hour. An exact hour waits a full hour. */
export function msUntilNextHour(now = Date.now()): number {
  const into = now % HOUR_MS;
  return into === 0 ? HOUR_MS : HOUR_MS - into;
}

/**
 * One check shortly after boot, then on each clock hour.
 * The script itself waits for the overnight window, so a check outside that window changes nothing.
 */
export function startUpdateScheduler() {
  if (process.env.UPDATE_ENABLED !== "1") return;
  const tick = () => {
    const child = spawn(process.execPath, [join(process.cwd(), "scripts", "self-update.mjs")], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  };
  setTimeout(tick, 15_000).unref();
  const hourly = setTimeout(() => {
    tick();
    setInterval(tick, HOUR_MS).unref();
  }, msUntilNextHour());
  hourly.unref();
}
