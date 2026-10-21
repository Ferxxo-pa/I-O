import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumLine, planUpdate, readTrustKey, restartPlan, verifySignature, windowsServerStopScript } from "../scripts/update-lib.mjs";
import {
  claimLock,
  currentVersion,
  installRelease,
  loadReleases,
  releaseLock,
  restorePreviousDist,
} from "../scripts/update-apply.mjs";
import { stampVersion } from "../scripts/pack-release.mjs";
import { msUntilNextHour } from "./update/schedule.ts";

const root = mkdtempSync(join(tmpdir(), "io-update-"));
const repoRoot = join(import.meta.dirname, "..");

function archive(dir: string, version: string, source: string) {
  const stage = join(dir, `stage-${version}`);
  mkdirSync(join(stage, "dist"), { recursive: true });
  writeFileSync(join(stage, "dist", "index.js"), source);
  stampVersion(join(stage, "dist"), version);
  const file = join(dir, `io-${version}.tar.gz`);
  spawnSync("tar", ["-czf", file, "-C", stage, "dist"], { stdio: "inherit" });
  const bytes = readFileSync(file);
  const sha = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha, sums: checksumLine(sha, `io-${version}.tar.gz`) };
}

function shop() {
  const dir = mkdtempSync(join(root, "shop-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "old");
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "punch.jsonl"), "arrive\n");
  writeFileSync(join(dir, "data", ".env"), "SQUARE_ACCESS_TOKEN=square-token-should-not-copy\n");
  return dir;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const good = archive(root, "0.2.1", "new");
const signature = sign(null, Buffer.from(good.sums), privateKey);

async function install(dir: string, packed: typeof good, extra: Record<string, unknown> = {}) {
  const files = new Map<string, Buffer>([
    ["https://example.invalid/tar", packed.bytes],
    ["https://example.invalid/sums", Buffer.from(packed.sums)],
    ["https://example.invalid/sig", signature],
  ]);
  await installRelease({
    root: dir,
    release: {
      version: "0.2.1",
      asset: "https://example.invalid/tar",
      sums: "https://example.invalid/sums",
      signatureUrl: "https://example.invalid/sig",
      sha256: "",
      signature: "",
    },
    pubkey: pem,
    fetchBytes: async (url: string) => {
      const hit = files.get(url);
      if (!hit) throw new Error("Download failed");
      return hit;
    },
    env: {},
    restart: false,
    ...extra,
  });
}

const signedShop = shop();
await install(signedShop, good);
assert.equal(readFileSync(join(signedShop, "dist", "index.js"), "utf8"), "new");
assert.equal(currentVersion(signedShop), "0.2.1");
assert.equal(readFileSync(join(signedShop, "data.pre-update", "punch.jsonl"), "utf8"), "arrive\n");
assert.equal(existsSync(join(signedShop, "data.pre-update", ".env")), false);
assert.equal(JSON.parse(readFileSync(join(signedShop, "update-pending.json"), "utf8")).version, "0.2.1");
assert.equal(
  planUpdate({
    enabled: true,
    channel: "stable",
    current: currentVersion(signedShop),
    releases: [{ version: "0.2.1", draft: false, prerelease: false }],
    now: Date.now(),
    at: "02:15",
    tz: "America/Chicago",
    windowMin: 90,
    applyNow: "now",
  }).action,
  "skip",
);
assert.equal(restorePreviousDist(signedShop), true);
assert.equal(readFileSync(join(signedShop, "dist", "index.js"), "utf8"), "old");
assert.equal(currentVersion(signedShop), "0.2.0");

const unsigned = shop();
await install(unsigned, good, { pubkey: "" });
assert.equal(readFileSync(join(unsigned, "dist", "index.js"), "utf8"), "new");

const flipped = Buffer.from(signature);
flipped[0] ^= 0xff;
const badSig = shop();
await assert.rejects(
  () =>
    install(badSig, good, {
      fetchBytes: async (url: string) => {
        if (url.endsWith("/sig")) return flipped;
        if (url.endsWith("/sums")) return Buffer.from(good.sums);
        return good.bytes;
      },
    }),
  /Bad signature/,
);
assert.equal(readFileSync(join(badSig, "dist", "index.js"), "utf8"), "old");
assert.equal(existsSync(join(badSig, "data.pre-update")), false);
assert.equal(existsSync(join(badSig, "update-pending.json")), false);

const badSum = shop();
const lied = checksumLine("ab".repeat(32), "io-0.2.1.tar.gz");
await assert.rejects(
  () =>
    install(badSum, good, {
      pubkey: "",
      fetchBytes: async (url: string) => (url.endsWith("/sums") ? Buffer.from(lied) : good.bytes),
    }),
  /Bad checksum/,
);
assert.equal(readFileSync(join(badSum, "dist", "index.js"), "utf8"), "old");

const broken = shop();
const noteDir = join(root, "note");
mkdirSync(noteDir, { recursive: true });
writeFileSync(join(noteDir, "note.txt"), "no dist");
const badArchive = join(root, "bad.tar.gz");
spawnSync("tar", ["-czf", badArchive, "-C", noteDir, "note.txt"], { stdio: "inherit" });
const badBytes = readFileSync(badArchive);
const badSha = createHash("sha256").update(badBytes).digest("hex");
await assert.rejects(
  () =>
    installRelease({
      root: broken,
      release: {
        version: "0.2.1",
        asset: "https://example.invalid/tar",
        sha256: badSha,
        signature: "",
      },
      pubkey: "",
      fetchBytes: async () => badBytes,
      env: {},
      restart: false,
    }),
  /Extract failed/,
);
assert.equal(readFileSync(join(broken, "dist", "index.js"), "utf8"), "old");
assert.equal(existsSync(join(broken, "update-pending.json")), false);

const rows = await loadReleases(
  { UPDATE_MANIFEST_URL: "https://example.invalid/manifest" },
  async () => ({
    ok: true,
    json: async () => ({
      version: "0.4.0",
      asset: "https://example.invalid/io.tar.gz",
      sha256: "cd".repeat(32),
      draft: false,
      signature: Buffer.from(signature).toString("base64"),
    }),
  }),
);
assert.equal(rows[0].version, "0.4.0");
assert.equal(rows[0].signature.length > 0, true);

const fromGithub = await loadReleases({ UPDATE_REPO: "Ferxxo-pa/I-O" }, async () => ({
  ok: true,
  json: async () => [
    {
      tag_name: "v0.9.0",
      draft: true,
      prerelease: false,
      assets: [{ name: "io-0.9.0.tar.gz", browser_download_url: "https://example.invalid/draft" }],
    },
    {
      tag_name: "v0.3.0",
      draft: false,
      prerelease: false,
      assets: [
        { name: "io-0.3.0.tar.gz", browser_download_url: "https://example.invalid/box" },
        { name: "SHA256SUMS", browser_download_url: "https://example.invalid/sums" },
        { name: "SHA256SUMS.sig", browser_download_url: "https://example.invalid/sig" },
      ],
    },
  ],
}));
assert.equal(fromGithub[1].asset, "https://example.invalid/box");
assert.equal(fromGithub[1].sums, "https://example.invalid/sums");
assert.equal(fromGithub[1].signatureUrl, "https://example.invalid/sig");
assert.equal(
  planUpdate({
    enabled: true,
    channel: "stable",
    current: "0.2.0",
    releases: fromGithub,
    now: Date.now(),
    at: "02:15",
    tz: "America/Chicago",
    windowMin: 90,
    applyNow: "now",
  }).release.version,
  "0.3.0",
);

const keyFile = join(root, "public.pem");
writeFileSync(keyFile, pem);
assert.equal(readTrustKey(keyFile, { existsSync, readFileSync }).includes("BEGIN PUBLIC KEY"), true);
const oneLine = pem.replace(/\n/g, "\\n");
assert.equal(verifySignature(readTrustKey(oneLine), good.sums, signature), true);

assert.equal(restartPlan("win32", {}), "windows");
assert.equal(restartPlan("linux", {}), "systemd");
assert.equal(restartPlan("win32", { UPDATE_RESTART: "0" }), "skip");
const stopScript = windowsServerStopScript(4321);
assert.equal(stopScript.includes("$self = 4321"), true);
assert.equal(stopScript.includes("dist"), true);
assert.equal(stopScript.includes("Stop-Process -Name"), false);

assert.equal(msUntilNextHour(0), 3_600_000);
assert.equal(msUntilNextHour(1_000), 3_599_000);
assert.equal(msUntilNextHour(3_600_000), 3_600_000);

const LOCK_NOW = 20 * 60 * 1000;
const lockDir = mkdtempSync(join(root, "lock-"));
assert.equal(claimLock(lockDir, 1_000), true);
assert.equal(claimLock(lockDir, 2_000), false);
utimesSync(join(lockDir, "update.lock"), new Date(0), new Date(0));
assert.equal(claimLock(lockDir, LOCK_NOW), true);
releaseLock(lockDir);
assert.equal(existsSync(join(lockDir, "update.lock")), false);
assert.equal(claimLock(lockDir, LOCK_NOW), true);
releaseLock(lockDir);

assert.throws(() => stampVersion(root, "yesterday"), /0\.2\.0/);

const sumsPath = join(root, "SHA256SUMS");
const sigPath = join(root, "SHA256SUMS.sig");
const privatePath = join(root, "signing-key.pem");
writeFileSync(sumsPath, good.sums);
writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
const signed = spawnSync(process.execPath, ["scripts/sign-checksum.mjs", sumsPath, sigPath, privatePath, "--print-public"], {
  cwd: repoRoot,
  encoding: "utf8",
});
assert.equal(signed.status, 0);
assert.equal(signed.stdout.includes("BEGIN PUBLIC KEY"), true);
assert.equal(signed.stdout.includes("PRIVATE"), false);
assert.equal(verifySignature(signed.stdout, readFileSync(sumsPath), readFileSync(sigPath)), true);

const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
assert.equal(workflow.includes("workflow_dispatch"), true);
assert.equal(workflow.includes("UPDATE_SIGNING_KEY"), true);
assert.equal(workflow.includes("scripts/sign-checksum.mjs"), true);
assert.equal(workflow.includes("scripts/pack-release.mjs"), true);
assert.equal(workflow.includes("--draft"), true);
assert.equal(workflow.includes("SHA256SUMS.sig"), true);
assert.equal(workflow.includes("refs/heads/main"), true);
assert.equal(workflow.includes("environment: release"), true);
assert.equal(workflow.includes("gh release edit"), false);
assert.equal(workflow.includes("deploy:cf"), false);

const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
assert.equal(ci.includes("pull_request"), true);
assert.equal(ci.includes("npm test"), true);
assert.equal(ci.includes("npm run check"), true);
assert.equal(ci.includes("npm run build"), true);
assert.equal(ci.includes("node-version: 22"), true);

function runUpdater(env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/self-update.mjs"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, ...env },
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`updater timed out\n${stderr}`));
    }, 15_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

const disabled = await runUpdater({ UPDATE_ENABLED: "0", UPDATE_APPLY: "now" });
assert.equal(disabled.status, 0);

async function serve(status: number, body: unknown) {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/manifest`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const quiet = await serve(200, {
  version: "0.0.1",
  asset: "https://example.invalid/old.tar.gz",
  sha256: "aa".repeat(32),
});
const nothingNew = await runUpdater({
  UPDATE_ENABLED: "1",
  UPDATE_APPLY: "now",
  UPDATE_RESTART: "0",
  UPDATE_MANIFEST_URL: quiet.url,
});
await quiet.close();
assert.equal(nothingNew.status, 0, nothingNew.stderr);
assert.equal(existsSync(join(repoRoot, "update.lock")), false);

const down = await serve(500, {});
const failed = await runUpdater({
  UPDATE_ENABLED: "1",
  UPDATE_APPLY: "now",
  UPDATE_RESTART: "0",
  UPDATE_MANIFEST_URL: down.url,
});
await down.close();
assert.equal(failed.status, 1);
assert.equal(failed.stderr.includes("Manifest fetch failed"), true);
assert.equal(existsSync(join(repoRoot, "update.lock")), false);

rmSync(root, { recursive: true, force: true });
console.log("update apply ok");
