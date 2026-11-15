import assert from "node:assert/strict";
import test from "node:test";
import { UpdateService, type UpdateCandidate, type UpdateContext, type UpdatePort } from "./updates";
import { isUpdateState, type UpdateMode } from "./update-contract";

const candidate = { version: "0.1.1-preview.3", releaseURL: "https://github.com/do-service/chat-apps/releases/tag/v0.1.1-preview.3" };
const foreground: UpdateContext = { current: () => true, foreground: () => true };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(mode: UpdateMode = "install") {
  const calls: string[] = [];
  let now = 1_000_000;
  let check: () => Promise<UpdateCandidate | null> = async () => candidate;
  let download: (progress: (percent: number) => void) => Promise<void> = async (progress) => { progress(35); };
  let confirm: (context: UpdateContext) => Promise<boolean> = async () => true;
  let install: (failed: (redownload?: boolean) => void) => void = () => { calls.push("install"); };
  const port: UpdatePort = {
    check: () => { calls.push("check"); return check(); }, download: (progress) => { calls.push("download"); return download(progress); },
    confirm: (context) => { calls.push("confirm"); return confirm(context); }, install: (failed) => install(failed), dispose: () => calls.push("dispose"),
  };
  const service = new UpdateService({ platform: "win32", currentVersion: "0.1.0", mode, port,
    openRelease: async (url) => { calls.push(url); }, now: () => now,
    prepareQuit: () => { calls.push("prepare"); return () => calls.push("rollback"); },
  });
  return { service, calls, advance: (ms: number) => { now += ms; },
    setCheck: (value: typeof check) => { check = value; }, setDownload: (value: typeof download) => { download = value; },
    setConfirm: (value: typeof confirm) => { confirm = value; }, setInstall: (value: typeof install) => { install = value; } };
}

test("update check coalesces, rate limits clicks and automatic six-hour checks without downloading", async () => {
  const f = fixture(); let finish: ((value: UpdateCandidate) => void) | undefined;
  f.setCheck(() => new Promise((resolve) => { finish = resolve; }));
  const first = f.service.check(); const second = f.service.check();
  assert.equal(f.service.getState().status, "checking"); assert.deepEqual(f.calls, ["check"]);
  assert.ok(finish); finish(candidate); await Promise.all([first, second]); f.setCheck(async () => candidate);
  assert.equal(f.service.getState().status, "available"); assert.equal(isUpdateState(f.service.getState()), true);
  await f.service.check(); f.advance(31_000); await f.service.check(true);
  assert.deepEqual(f.calls, ["check"]);
  f.advance(6 * 60 * 60_000); await f.service.check(true); assert.deepEqual(f.calls, ["check", "check"]);
});

test("download returns promptly, is single flight, clamps progress and requires ready before install", async () => {
  const f = fixture(); await f.service.install(foreground); assert.equal(f.calls.length, 0);
  await f.service.download(); assert.equal(f.calls.length, 0);
  await f.service.check(); let finish: (() => void) | undefined; let report: ((percent: number) => void) | undefined;
  f.setDownload((progress) => new Promise<void>((resolve) => { finish = resolve; report = progress; }));
  assert.equal((await f.service.download()).status, "downloading"); await f.service.download();
  assert.deepEqual(f.calls, ["check", "download"]); assert.ok(report); report(42); assert.equal(f.service.getState().progress, 42);
  report(Number.NaN); report(101); assert.equal(f.service.getState().progress, 42);
  await f.service.install(foreground); assert.equal(f.calls.includes("confirm"), false);
  assert.ok(finish); finish(); await settle(); assert.equal(f.service.getState().status, "ready");
  await f.service.install(foreground); assert.deepEqual(f.calls, ["check", "download", "confirm", "prepare", "install"]);
  assert.equal(f.service.getState().status, "installing");
});

test("install confirmation is native-owned, coalesced and rechecks current foreground document", async () => {
  for (const invalidate of ["cancel", "document", "foreground"]) {
    const f = fixture(); await f.service.check(); await f.service.download(); await settle();
    let finish: ((value: boolean) => void) | undefined; let current = true; let focused = true;
    const context = { current: () => current, foreground: () => focused };
    f.setConfirm(() => new Promise((resolve) => { finish = resolve; }));
    const installing = f.service.install(context); await f.service.install(context);
    assert.equal(f.calls.filter((value) => value === "confirm").length, 1); assert.ok(finish);
    if (invalidate === "document") current = false;
    if (invalidate === "foreground") focused = false;
    finish(invalidate !== "cancel"); await installing;
    assert.equal(f.service.getState().status, "ready"); assert.equal(f.calls.includes("prepare"), false);
  }
});

test("background or stale context cannot prompt or open a release", async () => {
  const f = fixture(); await f.service.check(); await f.service.download(); await settle();
  for (const context of [{ current: () => false, foreground: () => true }, { current: () => true, foreground: () => false }]) {
    await f.service.install(context); await f.service.openRelease(context);
  }
  assert.deepEqual(f.calls, ["check", "download"]);
  await f.service.openRelease(foreground); assert.equal(f.calls.at(-1), candidate.releaseURL);
});

test("external mode never downloads or installs, unconfigured mode never checks", async () => {
  const f = fixture("external"); await f.service.check(); await f.service.download(); await f.service.install(foreground);
  assert.deepEqual(f.calls, ["check"]); await f.service.openRelease(foreground); assert.equal(f.calls.at(-1), candidate.releaseURL);
  const disabled = fixture("unconfigured"); await disabled.service.check(); await disabled.service.download();
  await disabled.service.install(foreground); await disabled.service.openRelease(foreground);
  assert.equal(disabled.service.getState().status, "unavailable"); assert.deepEqual(disabled.calls, []);
});

test("network/download/signature/install errors are safe snapshots and allow explicit retry", async () => {
  const f = fixture(); f.setCheck(async () => { throw new Error("secret network URL"); });
  assert.equal((await f.service.check()).error, "network"); f.advance(31_000); f.setCheck(async () => candidate); await f.service.check();
  f.setDownload(async () => { throw Object.assign(new Error("secret installer path"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }); });
  await f.service.download(); await settle(); assert.equal(f.service.getState().error, "signature-mismatch");
  f.setDownload(async () => {}); await f.service.download(); await settle();
  f.setInstall(() => { throw new Error("secret path"); }); await f.service.install(foreground);
  assert.equal(f.service.getState().error, "install-failed"); assert.deepEqual(f.calls.slice(-3), ["confirm", "prepare", "rollback"]);
  assert.equal(JSON.stringify(f.service.getState()).includes("secret"), false);
});

test("cache eviction or changed installer hash rolls back quit and requires a fresh explicit download", async () => {
  const f = fixture(); await f.service.check(); await f.service.download(); await settle();
  f.setInstall((failed) => failed(true));
  assert.equal((await f.service.install(foreground)).error, "download-failed");
  const confirmations = f.calls.filter((value) => value === "confirm").length;
  await f.service.install(foreground); assert.equal(f.calls.filter((value) => value === "confirm").length, confirmations);
  await f.service.download(); await settle(); assert.equal(f.service.getState().status, "ready");
  assert.equal(f.calls.filter((value) => value === "download").length, 2);
});

test("late completion after dispose cannot publish candidate or ready state", async () => {
  const f = fixture(); let finish: ((value: UpdateCandidate) => void) | undefined;
  f.setCheck(() => new Promise((resolve) => { finish = resolve; })); const pending = f.service.check();
  f.service.dispose(); assert.ok(finish); finish(candidate); await pending;
  assert.equal(f.service.getState().availableVersion, null);
  const g = fixture(); await g.service.check(); let done: (() => void) | undefined;
  g.setDownload(() => new Promise((resolve) => { done = resolve; })); await g.service.download(); g.service.dispose();
  assert.ok(done); done(); await settle(); assert.notEqual(g.service.getState().status, "ready");
});
