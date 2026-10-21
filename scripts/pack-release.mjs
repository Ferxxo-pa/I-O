import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseVersionOk } from "./update-lib.mjs";

/** The updater reads this file from dist. package.json stays on the shop disk and is not in the archive. */
export function stampVersion(distDir, version) {
  const clean = String(version || "").trim();
  if (!releaseVersionOk(clean)) throw new Error("Version must look like 0.2.0");
  writeFileSync(join(distDir, "version.json"), `${JSON.stringify({ version: clean })}\n`);
}

function main() {
  const version = String(process.argv[2] || "").trim();
  const root = process.argv[3] || process.cwd();
  stampVersion(join(root, "dist"), version);
  const name = `io-${version}.tar.gz`;
  const tar = spawnSync("tar", ["-czf", name, "dist"], { cwd: root, stdio: "inherit" });
  if (tar.status !== 0) process.exit(tar.status ?? 1);
  const sum = spawnSync("sha256sum", [name], { cwd: root, encoding: "utf8" });
  if (sum.status !== 0) process.exit(sum.status ?? 1);
  writeFileSync(join(root, "SHA256SUMS"), sum.stdout.endsWith("\n") ? sum.stdout : `${sum.stdout}\n`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) main();
