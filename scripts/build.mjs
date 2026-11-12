import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildNotificationPermission } from "./build-native.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const diagnostic = process.argv.includes("--spike");
let raw = diagnostic ? undefined : process.env.DESKTOP_APP_URL;
if (!diagnostic && raw === undefined) {
  let config;
  try { config = JSON.parse(await readFile(new URL("../app-config.json", import.meta.url), "utf8")); }
  catch { throw new Error("Unable to read desktop app-config.json"); }
  if (typeof config !== "object" || config === null || Array.isArray(config)
      || Object.keys(config).length !== 1 || typeof config.appUrl !== "string") {
    throw new Error("Invalid desktop app-config.json: expected one appUrl string");
  }
  raw = config.appUrl;
}
let appUrl = null;
if (raw !== undefined) {
  if (!/^https:\/\/[^/?#]+\/?$/i.test(raw) || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error("DESKTOP_APP_URL must be an explicit HTTPS origin root");
  }
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("DESKTOP_APP_URL must be a valid HTTPS origin root"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("DESKTOP_APP_URL must be an HTTPS origin without credentials, path, query or fragment");
  }
  appUrl = url.origin;
}

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await buildNotificationPermission();
await build({
  absWorkingDir: root,
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts", "external-link-preload": "src/external-link-preload.ts" },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: false,
});
await cp(new URL("../build/icons/icon.png", import.meta.url), new URL("../dist/app-icon.png", import.meta.url));
await cp(new URL("../spike/", import.meta.url), new URL("../dist/spike/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/desktop-config.json", import.meta.url), JSON.stringify(diagnostic ? { appUrl: null, spike: true } : { appUrl }) + "\n");
console.log(diagnostic ? "Desktop diagnostic build complete: explicit --spike build, including cold launch" : "Desktop build complete: configured HTTPS origin embedded");
