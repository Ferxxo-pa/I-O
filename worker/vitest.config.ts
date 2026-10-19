import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));
  return {
    test: {
      root: path.resolve(here, ".."),
      include: ["worker/test/**/*.spec.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: path.join(here, "wrangler.test.toml") },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
