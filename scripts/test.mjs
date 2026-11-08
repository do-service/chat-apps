import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = (await readdir(path.join(root, "src"))).filter((name) => name.endsWith(".test.ts")).sort();
if (!tests.length) throw new Error("No desktop tests found");
await build({
  absWorkingDir: root,
  entryPoints: tests.map((name) => path.join("src", name)),
  outdir: "dist-tests",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
const result = spawnSync(process.execPath, ["--test", ...tests.map((name) => path.join(root, "dist-tests", name.replace(/\.ts$/, ".cjs")))], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
