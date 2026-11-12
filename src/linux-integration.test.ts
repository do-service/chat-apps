import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { APP_ID } from "./contract";

test("real electron-builder helper aligns AppImage desktop basename, StartupWMClass and Electron identity", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { readFileSync, statSync } from "node:fs";
    import { resolve } from "node:path";
    const require = createRequire(resolve("package.json"));
    const { Packager } = require("app-builder-lib/out/packager");
    const { LinuxPackager } = require("app-builder-lib/out/linuxPackager");
    const { LinuxTargetHelper } = require("app-builder-lib/out/targets/LinuxTargetHelper");
    const { getFileMatchers } = require("app-builder-lib/out/fileMatcher");
    const info = new Packager({ projectDir: process.cwd(), config: "electron-builder.yml" });
    await info.validateConfig();
    const linux = new LinuxPackager(info);
    const helper = new LinuxTargetHelper(linux);
    const desktopName = ${JSON.stringify(`${APP_ID}.desktop`)};
    assert.equal(info.metadata.desktopName, desktopName);
    assert.equal(linux.platformSpecificBuildOptions.syncDesktopName, true);
    assert.equal(helper.getDesktopFileName() + ".desktop", desktopName);
    const entry = await helper.computeDesktopEntry(linux.platformSpecificBuildOptions, "AppRun %U");
    const fields = Object.fromEntries(entry.split("\\n").filter(line => line.includes("=")).map(line => {
      const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(fields.StartupWMClass, ${JSON.stringify(APP_ID)});
    assert.match(entry, /^Icon=chat-desktop-spike$/m);
    assert.match(entry, /^Exec=AppRun %U$/m);
    assert.equal(info.config.appId, ${JSON.stringify(APP_ID)});
    assert.equal(info.metadata.name, "chat-desktop-spike");
    assert.equal(info.config.productName, "Chat Desktop Spike");
    const matchers = getFileMatchers(info.config, "files", resolve("dist-tests/package-payload"), {
      macroExpander: value => value, customBuildOptions: linux.platformSpecificBuildOptions,
      globalOutDir: resolve("release"), defaultSrc: process.cwd(),
    });
    assert.equal(matchers.length, 1);
    const selected = matchers[0].createFilter();
    const fileStat = statSync(resolve("build/icons/icon.png"));
    assert.equal(selected(resolve("dist/app-icon.png"), fileStat), true);
    assert.equal(selected(resolve("package.json"), fileStat), true);
    assert.equal(selected(resolve("src/main.ts"), fileStat), false);
    assert.deepEqual(readFileSync(resolve(linux.platformSpecificBuildOptions.icon)),
      readFileSync(resolve("build/icons/icon.png")));
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
