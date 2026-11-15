import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import * as filesystem from "node:fs";
import * as paths from "node:path";
import { tmpdir } from "node:os";
import { parseUpdateInfo } from "electron-updater/out/providers/Provider";
import * as contract from "./contract";
import * as release from "./update-release";
import * as updateFiles from "./update-files";
import { CancellationToken } from "electron-updater/out/types";
import { resolveConfiguration } from "./config";

const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/electron-updates.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);
const version = "0.1.1-preview.3";
const filename = `chat-desktop-${version}-win-x64.exe`;
const root = `https://github.com/do-service/chat-apps/releases/download/v${version}/`;
const config = resolveConfiguration([], undefined, { appUrl: "https://chat.example", updateDistribution: "github-preview" });
const feed = { provider: "github", owner: "do-service", repo: "chat-apps", channel: "preview", publisherName: ["Chat Publisher"] };
type RequestGuard = (details: { url: string }, callback: (value: { cancel?: boolean }) => void) => void;
type HeaderGuard = (details: { url: string; statusCode: number; responseHeaders?: Record<string, string[]> }, callback: (value: { cancel?: boolean }) => void) => void;
type SendGuard = (details: unknown, callback: (value: { requestHeaders?: Record<string, string> }) => void) => void;

function fixture(os = "win32", packaged = true, nativeFilesystem = false) {
  let before: RequestGuard | undefined; let headers: HeaderGuard | undefined; let send: SendGuard | undefined;
  const requests: string[] = []; const instances: Updater[] = []; let quit = 0;
  const signatureChecks: string[] = []; let signatureValid = true;
  let install: (updater: Updater) => boolean = () => true;
  let download: (token: CancellationToken, updater: Updater) => Promise<string[]> = async () => ["private-cache.exe"];
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const setTimer = (callback: () => void, delay: number) => { const timer = { unref() {} }; timers.set(timer, { callback, delay }); return timer; };
  const ses = { webRequest: {
    onBeforeRequest: (_filter: unknown, callback: RequestGuard) => { before = callback; },
    onBeforeSendHeaders: (_filter: unknown, callback: SendGuard) => { send = callback; },
    onHeadersReceived: (_filter: unknown, callback: HeaderGuard) => { headers = callback; },
  } };
  class Updater extends EventEmitter {
    constructor(readonly options: unknown) { super(); instances.push(this); }
    netSession = ses; logger: unknown; autoDownload = true; autoInstallOnAppQuit = true;
    allowPrerelease = false; allowDowngrade = true; disableWebInstaller = false; disableDifferentialDownload = false;
    get channel() { return "preview"; } set channel(_value: string) { this.allowDowngrade = true; }
    async getUpdateInfoAndProvider(): Promise<unknown> { throw new Error("No candidate"); }
    async checkForUpdates() { await this.getUpdateInfoAndProvider(); return { isUpdateAvailable: true }; }
    async downloadUpdate(token: CancellationToken) { return download(token, this); }
    install() { return install(this); }
  }
  class MockProvider {}
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  let confirm: (signal: AbortSignal) => Promise<{ response: number }> = async () => ({ response: 1 });
  const prompts: { buttons: string[]; cancelId: number; defaultId: number }[] = [];
  const modules: Record<string, unknown> = {
    electron: { app: { isPackaged: packaged, getVersion: () => "0.1.0", quit: () => { quit++; } },
      dialog: { showMessageBox: (_window: unknown, options: { signal: AbortSignal; buttons: string[]; cancelId: number; defaultId: number }) => { prompts.push(options); return confirm(options.signal); } } },
    "node:fs": nativeFilesystem ? filesystem : { lstatSync: () => ({ size: 1024 }), readFileSync: () => JSON.stringify(feed) },
    "node:path": paths,
    "electron-updater": { NsisUpdater: Updater, AppImageUpdater: Updater, CancellationToken, Provider: MockProvider },
    "./update-files": updateFiles,
    "./update-signature": { verifyWindowsSignature: async (_publishers: string[], path: string) => { signatureChecks.push(path); return signatureValid ? null : "Rejected signature"; } },
    "electron-updater/out/electronHttpExecutor": { ElectronHttpExecutor: class {} },
    "electron-updater/out/providers/Provider": { parseUpdateInfo },
    "./contract": contract, "./update-release": release,
    "./update-transport": { readPublicUpdateMetadata: async (url: string) => {
      requests.push(url);
      if (url === release.RELEASE_API) return JSON.stringify([{ tag_name: `v${version}`, draft: false, prerelease: true,
        assets: [filename, "preview.yml", `chat-desktop-${version}-mac-x64.dmg`].map((name) => ({ name, size: 2048, browser_download_url: root + name })) }]);
      return `version: ${version}\nfiles:\n  - url: ${filename}\n    sha512: ${Buffer.alloc(64, 42).toString("base64")}\n    size: 2048\n`;
    } },
  };
  const module = { exports: {} };
  runInNewContext(compiled.stdout, { require: (name: string) => modules[name], module, exports: module.exports,
    process: { resourcesPath: "/resources", env: {}, arch: "x64" }, URL, Buffer, AbortController, setImmediate,
    setTimeout: setTimer, clearTimeout: (timer: object) => timers.delete(timer) });
  const result: unknown = module.exports; assert.ok(contract.isRecord(result));
  const create: unknown = result.createElectronUpdatePort; const policy: unknown = result.desktopUpdateMode;
  const writable: unknown = result.writableAppImage;
  assert.ok(typeof create === "function"); assert.ok(typeof policy === "function"); assert.ok(typeof writable === "function");
  const value: unknown = create(config, os, { window: () => window }); assert.ok(contract.isRecord(value));
  const port: unknown = value.port; assert.ok(contract.isRecord(port));
  // Validate each port boundary rather than casting an untyped VM object.
  function method(name: string): (...args: unknown[]) => unknown {
    const fn: unknown = contract.isRecord(port) ? port[name] : undefined; assert.ok(typeof fn === "function"); return (...args) => fn(...args);
  }
  return { instances, requests, prompts, window, policy, writable, mode: value.mode, call: method, signatureChecks,
    rejectSignature: () => { signatureValid = false; },
    quit: () => quit, setInstall: (value: typeof install) => { install = value; },
    pendingDownload: () => {
      let finish = () => {};
      download = (token) => token.createPromise<string[]>((resolve) => { finish = () => resolve(["private-cache.exe"]); });
      const result = method("download")(() => {});
      return { result, finish: () => finish() };
    },
    expire: (delay: number) => { for (const [timer, value] of timers) if (value.delay === delay) { timers.delete(timer); value.callback(); break; } },
    timerCount: () => timers.size,
    setConfirmation: (value: typeof confirm) => { confirm = value; },
    requestAllowed: (url: string) => { let cancelled: boolean | undefined; assert.ok(before); before({ url }, (value) => { cancelled = value.cancel; }); return cancelled === false; },
    responseAllowed: (url: string, statusCode: number, responseHeaders: Record<string, string[]>) => {
      let cancelled: boolean | undefined; assert.ok(headers); headers({ url, statusCode, responseHeaders }, (value) => { cancelled = value.cancel; }); return cancelled === false;
    },
    sentHeaders: () => { let result: unknown; assert.ok(send); send({}, (value) => { result = value.requestHeaders; }); return result; },
  };
}

test("desktop eligibility requires embedded distribution + packaged + fixed feed and actual writable AppImage", () => {
  const f = fixture();
  for (const disabled of [resolveConfiguration([], undefined, { appUrl: "https://chat.example" }), resolveConfiguration(["--spike"], undefined, { appUrl: "https://chat.example" })]) {
    assert.equal(f.policy(disabled, "win32", true, feed, true), "unconfigured");
  }
  assert.equal(f.policy(config, "win32", false, feed, true), "unconfigured");
  assert.equal(f.policy(config, "darwin", true, null, false), "external");
  assert.equal(f.policy(config, "win32", true, feed, false), "install");
  for (const invalid of [null, { ...feed, publisherName: undefined }, { ...feed, publisherName: [] }, { ...feed, publisherName: [""] }, { ...feed, owner: "evil" }, { ...feed, token: "never-read" }]) {
    assert.equal(f.policy(config, "win32", true, invalid, false), "external");
  }
  assert.equal(f.policy(config, "linux", true, feed, false), "external");
  assert.equal(f.policy(config, "linux", true, feed, true), "install");
  assert.equal(fixture("darwin").instances.length, 0);
});

test("AppImage eligibility requires a real owned executable writable type-2 image, not a symlink or arbitrary path", () => {
  const f = fixture("linux", true, true);
  const parent = filesystem.realpathSync(tmpdir());
  const directory = filesystem.mkdtempSync(paths.join(parent, "chat-appimage-policy-"));
  try {
    const image = paths.join(directory, "Chat.AppImage");
    const bytes = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1, 1, 0, 65, 73, 2]).copy(bytes);
    bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52);
    filesystem.writeFileSync(image, bytes, { mode: 0o700 });
    assert.equal(f.writable(image), true);
    const link = paths.join(directory, "Link.AppImage"); filesystem.symlinkSync(image, link);
    for (const value of [undefined, "relative.AppImage", directory, link, paths.join(directory, "missing.AppImage"), image + "\0"]) assert.equal(f.writable(value), false);
    filesystem.chmodSync(image, 0o600); assert.equal(f.writable(image), false);
    filesystem.chmodSync(image, 0o700); filesystem.writeFileSync(image, "not-an-AppImage"); assert.equal(f.writable(image), false);
  } finally {
    const target = filesystem.realpathSync(directory);
    assert.equal(target, directory); assert.equal(paths.dirname(target), parent); assert.ok(paths.basename(target).startsWith("chat-appimage-policy-"));
    filesystem.rmSync(target, { recursive: true });
  }
});

test("updater pin adapter disables implicit downloads/quit installs/downgrades and suppresses raw logging", async () => {
  const f = fixture(); assert.equal(f.mode, "install"); const updater = f.instances[0]; assert.ok(updater);
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, true); assert.equal(updater.allowDowngrade, false); assert.equal(updater.logger, null);
  assert.equal(updater.disableWebInstaller, true); assert.equal(updater.disableDifferentialDownload, true);
  await f.call("check")(); assert.deepEqual(f.requests, [release.RELEASE_API, root + "preview.yml"]);
  const active = f.pendingDownload();
  assert.equal(f.requestAllowed(root + filename), true); assert.equal(f.requestAllowed(root + "other.exe"), false);
  assert.equal(f.requestAllowed("https://evil.example/a.exe"), false);
  assert.deepEqual(structuredClone(f.sentHeaders()), { Accept: "application/octet-stream", "User-Agent": "Chat-Desktop-Updates" });
  assert.equal(f.responseAllowed(root + filename, 200, { "Content-Length": ["2048"] }), true);
  active.finish(); await active.result; assert.equal(f.timerCount(), 0);
  const invalidHeaders: Array<Record<string, string[]>> = [{}, { "Content-Length": ["2049"] }, { "Content-Length": ["bad"] }];
  for (const headers of invalidHeaders) {
    const pending = f.pendingDownload(); assert.equal(f.responseAllowed(root + filename, 200, headers), false);
    await assert.rejects(async () => pending.result);
  }
  for (const location of ["https://evil.example/a", "http://[malformed", "file:///tmp/a"]) {
    const pending = f.pendingDownload(); assert.equal(f.responseAllowed(root + filename, 302, { location: [location] }), false);
    await assert.rejects(async () => pending.result);
  }
});

test("a hash-valid upstream cached Windows download is rechecked by the fail-closed OS verifier", async () => {
  const f = fixture(); await f.call("check")();
  const good = f.pendingDownload(); good.finish(); await good.result; assert.deepEqual(f.signatureChecks, ["private-cache.exe"]);
  f.rejectSignature(); const rejected = f.pendingDownload(); rejected.finish();
  await assert.rejects(async () => rejected.result, { code: "ERR_UPDATER_INVALID_SIGNATURE" }); assert.equal(f.timerCount(), 0);
});

test("binary CDN loops have an independent redirect budget and inactivity/overall watchdogs settle and clean up", async () => {
  const f = fixture(); await f.call("check")();
  const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/1/a?sig=fake";
  const pending = f.pendingDownload();
  for (let i = 0; i < 8; i++) assert.equal(f.responseAllowed(cdn, 302, { location: [cdn] }), true);
  assert.equal(f.responseAllowed(cdn, 302, { location: [cdn] }), false);
  await assert.rejects(async () => pending.result); assert.equal(f.timerCount(), 0);
  for (const delay of [60_000, 15 * 60_000]) {
    const stalled = f.pendingDownload(); assert.equal(f.responseAllowed(root + filename, 200, { "Content-Length": ["2048"] }), true);
    f.expire(delay); await assert.rejects(async () => stalled.result); assert.equal(f.timerCount(), 0);
  }
  const retry = f.pendingDownload(); assert.equal(f.responseAllowed(cdn, 302, { location: [cdn] }), true);
  retry.finish(); await retry.result; assert.equal(f.timerCount(), 0);
});

test("native foreground confirmation defaults to cancel and aborts on window/navigation loss", async () => {
  const f = fixture(); await f.call("check")();
  assert.equal(await f.call("confirm")({ current: () => true, foreground: () => true }), true);
  assert.equal(f.prompts[0]?.cancelId, 0); assert.equal(f.prompts[0]?.defaultId, 0);
  assert.equal(await f.call("confirm")({ current: () => true, foreground: () => false }), false);
  for (const event of ["hide", "minimize", "closed", "did-start-navigation", "render-process-gone"]) {
    f.setConfirmation(async (signal) => { (event.startsWith("did-") || event === "render-process-gone" ? f.window.webContents : f.window).emit(event); return { response: signal.aborted ? 0 : 1 }; });
    assert.equal(await f.call("confirm")({ current: () => true, foreground: () => true }), false);
  }
});

test("install boolean/event failures never quit and an emitted failure permits retry without duplicate install", async () => {
  const f = fixture(); await f.call("check")(); let failed = 0; let attempts = 0;
  f.setInstall((updater) => { attempts++; updater.emit("error", new Error("private installer path")); return false; });
  f.call("install")(() => { failed++; }); await new Promise<void>((done) => setImmediate(done));
  assert.equal(failed, 1); assert.equal(f.quit(), 0); assert.equal(attempts, 1);
  f.setInstall(() => { attempts++; return true; }); f.call("install")(() => { failed++; });
  await new Promise<void>((done) => setImmediate(done)); assert.equal(f.quit(), 1); assert.equal(attempts, 2);
  const g = fixture(); await g.call("check")();
  g.setInstall((updater) => { queueMicrotask(() => updater.emit("error", new Error("private URL"))); return true; });
  g.call("install")(() => { failed++; }); await new Promise<void>((done) => setImmediate(done)); assert.equal(g.quit(), 0);
});
