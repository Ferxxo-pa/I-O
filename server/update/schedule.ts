import { spawn } from "node:child_process";
import { join } from "node:path";

/** Hourly check. The script itself waits for the overnight window. */
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
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
}
