import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextBootAction } from "./update-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function loadEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

loadEnv(join(root, ".env"));
process.env.NODE_ENV = process.env.NODE_ENV || "production";
if (process.env.IO_MODE === "public" && !process.env.HOST) process.env.HOST = "127.0.0.1";

const pendingPath = join(root, "update-pending.json");

function readPending() {
  if (!existsSync(pendingPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pendingPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function probeUrls() {
  const port = process.env.PORT || "5000";
  const urls = [`http://127.0.0.1:${port}/api/health?probe=1`];
  const host = process.env.HOST?.trim();
  if (host && host !== "0.0.0.0" && host !== "::") urls.push(`http://${host}:${port}/api/health?probe=1`);
  const lan = process.env.LAN_BASE_URL?.trim().replace(/\/+$/, "");
  if (lan) urls.push(`${lan}/api/health?probe=1`);
  return urls;
}

async function healthy() {
  const deadline = Date.now() + 25_000;
  const urls = probeUrls();
  while (Date.now() < deadline) {
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const body = await res.json();
        if (body?.ok === true) return true;
      } catch {
        // The process is still binding.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function startServer() {
  return spawn(process.execPath, [join(root, "dist", "index.js")], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
}

function follow(child) {
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

function rollback() {
  const previous = join(root, "dist.previous");
  const dist = join(root, "dist");
  if (!existsSync(previous)) return;
  rmSync(dist, { recursive: true, force: true });
  renameSync(previous, dist);
}

const pending = readPending();
const child = startServer();

if (!pending || pending.rolledBack) {
  follow(child);
} else {
  const ok = await healthy();
  const action = nextBootAction(pending, ok);
  if (action === "ok") {
    rmSync(pendingPath, { force: true });
    follow(child);
  } else {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rollback();
    writeFileSync(pendingPath, JSON.stringify({ ...pending, rolledBack: true, at: Date.now() }));
    follow(startServer());
  }
}
