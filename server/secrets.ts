import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function tighten(path: string, mode: number) {
  try {
    if (!existsSync(path)) return;
    chmodSync(path, mode);
  } catch {
    // A read-only root or Windows leaves this to the installer / lock-secrets.cmd.
  }
}

/** .env and DATA_DIR are owner-read/write. Called from process start, not from tests. */
export function lockSecrets() {
  const envFile = process.env.IO_ENV_FILE?.trim() || join(process.cwd(), ".env");
  tighten(envFile, 0o600);
  const dir = process.env.DATA_DIR?.trim() || join(process.cwd(), "data");
  tighten(dir, 0o700);
  if (!existsSync(dir)) return;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (statSync(path).isFile()) tighten(path, 0o600);
    } catch {
      // Keep going. One unreadable name should not stop the shop clock.
    }
  }
}

/** Production refuses uid 0. Tests and development stay as the user who started them. */
export function mustRefuseRoot(nodeEnv: string | undefined, uid: number | undefined): boolean {
  return nodeEnv === "production" && uid === 0;
}
