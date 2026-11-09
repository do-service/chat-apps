import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LinuxPackager, archFromString } from "app-builder-lib";
import { getConfig } from "app-builder-lib/out/util/config/load.js";
import { prepareArtifacts } from "./artifacts.mjs";

const script = fileURLToPath(new URL("./artifacts.mjs", import.meta.url));
const filenames = {
  windows: ["chat-desktop-spike-0.1.0-win-x64.exe"],
  macos: ["chat-desktop-spike-0.1.0-mac-arm64.dmg", "chat-desktop-spike-0.1.0-mac-x64.dmg"],
  linux: ["chat-desktop-spike-0.1.0-linux-x86_64.AppImage"],
};

async function fixture(t, platform = "windows", names = filenames[platform], version = "0.1.0") {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-artifacts-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("desktop-artifacts-test-"));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  await mkdir(path.join(root, "release"));
  for (const name of names) await writeFile(path.join(root, "release", name), `installer:${name}\n`);
  return root;
}

for (const platform of Object.keys(filenames)) {
  test(`${platform}: exact allowlist and portable SHA-256 manifest`, async (t) => {
    const root = await fixture(t, platform);
    const names = filenames[platform];
    const expectedPaths = names.map((name) => `release/${name}`).concat("release/SHA256SUMS.txt");
    assert.deepEqual(await prepareArtifacts(root, platform), expectedPaths);
    const lines = await Promise.all(names.map(async (name) => {
      const bytes = await readFile(path.join(root, "release", name));
      return `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
    }));
    assert.equal(await readFile(path.join(root, "release/SHA256SUMS.txt"), "utf8"), lines.join(""));
  });
}

for (const [platform, names] of Object.entries({
  windows: ["chat-desktop-spike-0.1.1-preview.1-win-x64.exe"],
  macos: ["chat-desktop-spike-0.1.1-preview.1-mac-arm64.dmg", "chat-desktop-spike-0.1.1-preview.1-mac-x64.dmg"],
  linux: ["chat-desktop-spike-0.1.1-preview.1-linux-x86_64.AppImage"],
})) {
  test(`${platform}: prerelease version retains exact installer names and checksums`, async (t) => {
    const root = await fixture(t, platform, names, "0.1.1-preview.1");
    assert.deepEqual(await prepareArtifacts(root, platform), names.map((name) => `release/${name}`).concat("release/SHA256SUMS.txt"));
    const lines = await Promise.all(names.map(async (name) => {
      const bytes = await readFile(path.join(root, "release", name));
      return `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
    }));
    assert.equal(await readFile(path.join(root, "release/SHA256SUMS.txt"), "utf8"), lines.join(""));
  });
}

test("linux: allowlist matches installed electron-builder expansion of the real config", async (t) => {
  const projectDir = fileURLToPath(new URL("../", import.meta.url));
  const metadata = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
  const { result: config } = await getConfig({ projectDir }, "electron-builder.yml");
  assert.deepEqual(config.linux.target, [{ target: "AppImage", arch: ["x64"] }]);
  const packager = new LinuxPackager({ config, metadata });
  // AppImageTarget.build uses this production expansion; do not duplicate its arch mapping.
  const name = packager.expandArtifactNamePattern(config.appImage, "AppImage", archFromString(config.linux.target[0].arch[0]));
  const root = await fixture(t, "linux", [name], metadata.version);
  assert.deepEqual(await prepareArtifacts(root, "linux"), [`release/${name}`, "release/SHA256SUMS.txt"]);
  assert.equal(name, `chat-desktop-spike-${metadata.version}-linux-x86_64.AppImage`);
});

test("unrelated release files, recursive directories and updater metadata never enter allowlist", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "release/latest.yml"), "private metadata");
  await writeFile(path.join(root, "release/unexpected.exe"), "unexpected");
  await writeFile(path.join(root, "release/debug.yaml"), "private debug");
  await mkdir(path.join(root, "release/win-unpacked"));
  await writeFile(path.join(root, "release/win-unpacked/secret.txt"), "secret");
  assert.deepEqual(await prepareArtifacts(root, "windows"), [
    `release/${filenames.windows[0]}`, "release/SHA256SUMS.txt",
  ]);
});

test("missing installer fails before manifest creation", async (t) => {
  const root = await fixture(t, "windows");
  await assert.rejects(prepareArtifacts(root, "macos"), /ENOENT|missing/i);
  await assert.rejects(readFile(path.join(root, "release/SHA256SUMS.txt")), { code: "ENOENT" });
});

test("empty installer is rejected", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "release", filenames.windows[0]), "");
  await assert.rejects(prepareArtifacts(root, "windows"), /non-empty regular file/i);
});

test("directory masquerading as installer is rejected", async (t) => {
  const root = await fixture(t, "linux");
  await mkdir(path.join(root, "release", filenames.windows[0]));
  await assert.rejects(prepareArtifacts(root, "windows"), /non-empty regular file/i);
});

test("installer symlink is rejected", { skip: process.platform === "win32" && "Windows symlink creation requires extra privileges" }, async (t) => {
  const root = await fixture(t, "linux");
  await symlink(path.join(root, "release", filenames.linux[0]), path.join(root, "release", filenames.windows[0]));
  await assert.rejects(prepareArtifacts(root, "windows"), /non-empty regular file/i);
});

test("release directory symlink is rejected", async (t) => {
  const root = await fixture(t);
  const other = path.join(root, "other");
  await mkdir(other);
  await writeFile(path.join(other, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await symlink(path.join(root, "release"), path.join(other, "release"), "junction");
  await assert.rejects(prepareArtifacts(other, "windows"), /regular directory/i);
});

test("existing checksum output is not overwritten", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "release/SHA256SUMS.txt"), "existing");
  await assert.rejects(prepareArtifacts(root, "windows"), { code: "EEXIST" });
  assert.equal(await readFile(path.join(root, "release/SHA256SUMS.txt"), "utf8"), "existing");
});

test("unsafe versions cannot inject paths or GitHub outputs", async (t) => {
  const root = await fixture(t);
  for (const version of ["../outside", "0.1.0\npaths=secret", "0.1.0\n", "0.1.0\r", "", null, 1]) {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
    await assert.rejects(prepareArtifacts(root, "windows"), /version/i);
  }
});

test("unknown platforms are rejected", async (t) => {
  const root = await fixture(t);
  await assert.rejects(prepareArtifacts(root, "../release"), /platform/i);
});

test("CLI emits verified paths to stdout and GitHub output", async (t) => {
  const root = await fixture(t);
  const output = path.join(root, "github-output");
  const result = spawnSync(process.execPath, [script, "windows"], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.stderr);
  const paths = `release/${filenames.windows[0]}\nrelease/SHA256SUMS.txt\n`;
  assert.equal(result.stdout, paths);
  assert.equal(await readFile(output, "utf8"), `paths<<DESKTOP_ARTIFACT_PATHS\n${paths}DESKTOP_ARTIFACT_PATHS\n`);
});

test("CLI fails closed on missing or extra platform arguments", (t) => {
  for (const args of [[], ["windows", "extra"], ["unknown"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /platform|Usage/i);
  }
});
