import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

test("production and diagnostic builds bundle the canonical PNG without changing the working dist payload", () => {
  const snapshot = () => ["dist/main.cjs", "dist/preload.cjs", "dist/external-link-preload.cjs", "dist/server-selection-preload.cjs", "dist/desktop-config.json", "dist/app-icon.png"].map((file) => {
    const path = resolve(file); return existsSync(path) ? readFileSync(path) : null;
  });
  const before = snapshot();
  const canonical = readFileSync(resolve("build/icons/icon.png"));
  assert.ok(canonical.length > 8);
  assert.equal(createHash("sha256").update(canonical).digest("hex"), "6413bfe9d546e5225fc9256a0ecec48df3a1272ea4bdc91c15b8e000222a95d3");
  const temporaryParent = realpathSync(tmpdir());
  const temporary = mkdtempSync(join(temporaryParent, "chat-desktop-build-test-"));
  try {
    for (const scenario of [
      { name: "production", args: [], distribution: undefined },
      { name: "release", args: [], distribution: "github-preview" },
      { name: "diagnostic", args: ["--spike"], distribution: undefined },
    ]) {
      const args = scenario.args;
      // A fresh layout for each mode prevents a prior build's icon from masking a missing copy.
      const fixtureRoot = join(temporary, scenario.name);
      const desktopRoot = fixtureRoot;
      mkdirSync(join(desktopRoot, "scripts"), { recursive: true });
      mkdirSync(join(desktopRoot, "build", "icons"), { recursive: true });
      for (const script of ["build.mjs", "build-native.mjs"]) {
        copyFileSync(resolve("scripts", script), join(desktopRoot, "scripts", script));
      }
      for (const directory of ["src", "native", "spike", "node_modules"]) {
        symlinkSync(resolve(directory), join(desktopRoot, directory), process.platform === "win32" ? "junction" : "dir");
      }
      copyFileSync(resolve("build/icons/icon.png"), join(desktopRoot, "build", "icons", "icon.png"));
      assert.equal(existsSync(join(desktopRoot, "dist")), false);
      const result = spawnSync(process.execPath, [join(desktopRoot, "scripts", "build.mjs"), ...args], {
        cwd: desktopRoot, encoding: "utf8", env: { ...process.env, DESKTOP_APP_URL: "https://chat.example", DESKTOP_UPDATE_DISTRIBUTION: scenario.distribution },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const bundled = readFileSync(join(desktopRoot, "dist", "app-icon.png"));
      assert.deepEqual(bundled, canonical);
      assert.deepEqual(bundled.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(bundled.readUInt32BE(16), 512); assert.equal(bundled.readUInt32BE(20), 512);
      assert.ok(readFileSync(join(desktopRoot, "dist", "main.cjs")).length > 0);
      const dialogPreload = join(desktopRoot, "dist", "external-link-preload.cjs");
      assert.equal(existsSync(dialogPreload), true, "Both build modes must bundle the isolated dialog preload");
      assert.ok(readFileSync(dialogPreload).length > 0);
      assert.ok(readFileSync(join(desktopRoot, "dist", "server-selection-preload.cjs")).length > 0,
        "Every build must include the isolated server selector preload");
      assert.deepEqual(JSON.parse(readFileSync(join(desktopRoot, "dist", "desktop-config.json"), "utf8")),
        args.length !== 0 ? { appUrl: null, spike: true } : { appUrl: "https://chat.example", ...(scenario.distribution ? { updateDistribution: scenario.distribution } : {}) });
      assert.deepEqual(snapshot(), before, "Build regression must not modify the working desktop payload");
    }
  } finally {
    const target = realpathSync(temporary);
    assert.equal(target, temporary);
    assert.equal(dirname(target), temporaryParent);
    assert.ok(basename(target).startsWith("chat-desktop-build-test-"));
    rmSync(target, { recursive: true });
  }
  assert.deepEqual(snapshot(), before, "Temporary fixture cleanup must not modify the working desktop payload");
});

test("release updater marker rejects unknown distribution and diagnostic builds before writing output", () => {
  const path = resolve("dist/desktop-config.json"); const before = existsSync(path) ? readFileSync(path) : null;
  for (const [distribution, args] of [["unknown", []], ["github-preview", ["--spike"]]] satisfies Array<[string, string[]]>) {
    const result = spawnSync(process.execPath, [resolve("scripts/build.mjs"), ...args], {
      encoding: "utf8", env: { ...process.env, DESKTOP_APP_URL: "https://chat.example", DESKTOP_UPDATE_DISTRIBUTION: distribution },
    });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /distribution|DESKTOP_UPDATE_DISTRIBUTION/);
    assert.deepEqual(existsSync(path) ? readFileSync(path) : null, before);
  }
});

test("build rejects non-origin URLs before embedding config and does not print sensitive input", () => {
  for (const value of ["", "http://chat.example", "https://chat.example/path", "https://chat.example/a/..",
    "https://chat.example?", "https://chat.example/#", "https://chat.example\\bad", "https://chat.example\n",
    "https://user:do-not-log-me@chat.example", "https://user:do-not-log-me@%"] ) {
    const result = spawnSync(process.execPath, [resolve("scripts/build.mjs")], {
      encoding: "utf8", env: { ...process.env, DESKTOP_APP_URL: value },
    });
    assert.notEqual(result.status, 0);
    assert.equal((result.stdout + result.stderr).includes("do-not-log-me"), false);
    assert.match(result.stderr, /DESKTOP_APP_URL/);
  }
});
