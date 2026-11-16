import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { APP_ID } from "./contract";
import { createLinuxDesktopIntegration } from "./linux-desktop-integration";
import type { LinuxDesktopEntryOptions, LinuxDesktopEntryResult } from "./linux-desktop-entry";

const fixtureRoots: string[] = [];
afterEach(() => {
  for (const path of fixtureRoots.splice(0)) {
    assert.equal(dirname(realpathSync(path)), realpathSync(tmpdir()));
    assert.ok(basename(path).startsWith("chat-linux-integration-"));
    rmSync(path, { recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "chat-linux-integration-"));
  fixtureRoots.push(root);
  const userDataDirectory = join(root, "profile"); mkdirSync(userDataDirectory);
  const appImage = join(root, "Chat.AppImage"); writeFileSync(appImage, "appimage"); chmodSync(appImage, 0o700);
  const iconSourcePath = join(root, "canonical.png");
  writeFileSync(iconSourcePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  const options: LinuxDesktopEntryOptions = { platform: "linux", appImage, homeDirectory: root,
    xdgDataHome: join(root, "share"), userDataDirectory, iconSourcePath };
  const desktopPath = join(root, "share", "applications", `${APP_ID}.desktop`);
  let answer: () => Promise<boolean> = async () => true;
  let current = true;
  let prompts = 0;
  const results: { result: LinuxDesktopEntryResult; manual: boolean }[] = [];
  const errors: boolean[] = [];
  const create = () => createLinuxDesktopIntegration({ options, current: () => current,
    confirm: async () => { prompts++; return answer(); },
    onResult: (result, manual) => { results.push({ result, manual }); }, onError: (manual) => { errors.push(manual); } });
  return { options, desktopPath, results, errors, create, prompts: () => prompts,
    answer: (value: typeof answer) => { answer = value; }, invalidate: () => { current = false; } };
}

test("AppImage startup offers once, decline writes no launcher, and menu can explicitly retry", async () => {
  const f = fixture(); f.answer(async () => false);
  await f.create()();
  assert.equal(f.prompts(), 1); assert.equal(existsSync(f.desktopPath), false);
  await f.create()();
  assert.equal(f.prompts(), 1, "startup refusal is remembered in the local profile");
  f.answer(async () => true);
  await f.create()(true);
  assert.equal(f.prompts(), 2); assert.equal(existsSync(f.desktopPath), true);
  assert.deepEqual(f.results, [{ result: "declined", manual: false }, { result: "registered", manual: true }]);
  assert.deepEqual(f.errors, []);
});

test("registered integration is idempotent and reports current through the explicit menu", async () => {
  const f = fixture(); const offer = f.create(); await offer();
  const before = readFileSync(f.desktopPath);
  await f.create()(); await offer(true);
  assert.equal(f.prompts(), 1);
  assert.deepEqual(readFileSync(f.desktopPath), before);
  assert.deepEqual(f.results.at(-1), { result: "unchanged", manual: true });
});

test("overlapping startup/menu actions share one pending consent", async () => {
  const f = fixture(); let finish: ((answer: boolean) => void) | undefined;
  f.answer(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const offer = f.create(); const startup = offer(); const menu = offer(true);
  assert.equal(startup, menu); assert.equal(f.prompts(), 1); assert.ok(finish);
  finish(true); await startup;
  assert.equal(f.prompts(), 1); assert.equal(f.results.length, 1);
});

test("quit/window invalidation during consent cannot create a launcher", async () => {
  const f = fixture(); f.answer(async () => { f.invalidate(); return true; });
  await f.create()();
  assert.equal(existsSync(f.desktopPath), false); assert.deepEqual(f.errors, []);
});

test("foreign entry fails closed, errors are reported, and no confirmation or overwrite happens", async () => {
  const f = fixture(); mkdirSync(join(f.options.xdgDataHome ?? "", "applications"), { recursive: true });
  writeFileSync(f.desktopPath, "[Desktop Entry]\nName=Someone else\n");
  await f.create()(true);
  assert.equal(f.prompts(), 0); assert.deepEqual(f.errors, [true]);
  assert.equal(readFileSync(f.desktopPath, "utf8"), "[Desktop Entry]\nName=Someone else\n");
});

test("ordinary Linux binary, other OS and stale context do not prompt", async () => {
  for (const mode of ["ordinary", "mac", "stale"]) {
    const f = fixture();
    if (mode === "ordinary") delete f.options.appImage;
    if (mode === "mac") f.options.platform = "darwin";
    if (mode === "stale") f.invalidate();
    await f.create()();
    assert.equal(f.prompts(), 0); assert.equal(existsSync(f.desktopPath), false); assert.deepEqual(f.errors, []);
  }
});
