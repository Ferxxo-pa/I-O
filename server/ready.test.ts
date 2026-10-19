import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const data = mkdtempSync(join(tmpdir(), "io-ready-"));
process.env.DATA_DIR = data;
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SHOP_PIN;
delete process.env.PRESENCE_PUBLIC_URL;
delete process.env.BACKUP_MAX_AGE_MS;
process.env.NODE_ENV = "development";

const { healthReport } = await import("./ready.ts");
const { resetPublicUrlCache } = await import("./publicUrl.ts");
const { registerRoutes } = await import("./routes.ts");

const realFetch = global.fetch;
const hits: string[] = [];
global.fetch = async (input, init) => {
  const url = String(input);
  hits.push(url);
  if (url === "https://io.example/api/health?probe=1") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.startsWith("https://down.example/")) {
    throw new Error("offline");
  }
  return realFetch(input, init);
};

writeFileSync(join(data, "backup.json"), JSON.stringify({ at: Date.now() - 3 * 3_600_000, dest: "/mnt/usb" }));
resetPublicUrlCache();
process.env.PRESENCE_PUBLIC_URL = "https://io.example";
const up = await healthReport();
const backup = up.checks.find((row) => row.id === "backup");
const url = up.checks.find((row) => row.id === "public_url");
assert.equal(backup?.ok, true);
assert.equal(backup?.note, "3h ago");
assert.equal(url?.ok, true);
assert.equal(url?.note, "io.example");
assert.ok(hits.includes("https://io.example/api/health?probe=1"));

resetPublicUrlCache();
process.env.PRESENCE_PUBLIC_URL = "http://io.example";
const insecure = await healthReport();
assert.equal(insecure.checks.find((row) => row.id === "public_url")?.detail, "Use https://");

resetPublicUrlCache();
process.env.PRESENCE_PUBLIC_URL = "https://down.example";
const offline = await healthReport();
assert.equal(offline.checks.find((row) => row.id === "public_url")?.ok, false);
assert.equal(offline.checks.find((row) => row.id === "public_url")?.detail, "Not reachable");

writeFileSync(join(data, "backup.json"), JSON.stringify({ at: Date.now() - 48 * 3_600_000 }));
const old = await healthReport();
assert.equal(old.checks.find((row) => row.id === "backup")?.ok, false);
assert.equal(old.checks.find((row) => row.id === "backup")?.detail, "2d ago");

const app = express();
const server = await registerRoutes(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const before = hits.length;
const probe = await fetch(`http://127.0.0.1:${port}/api/health?probe=1`);
const body = await probe.json();
assert.equal(probe.status, 200);
assert.deepEqual(body, { ok: true });
const added = hits.slice(before);
assert.equal(added.some((url) => url.includes("/api/health?probe=1") && url.startsWith("https://")), false);
await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
const { earnEngine } = await import("./clock/engine.ts");
const { stopPresence } = await import("./presence/service.ts");
earnEngine.stop();
stopPresence();

console.log("ready ok");
