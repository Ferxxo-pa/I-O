import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const relay = join(root, "relay");
const result = spawnSync("npx", ["--yes", "wrangler", "deploy"], {
  cwd: relay,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
