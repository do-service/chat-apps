import assert from "node:assert/strict";
import test from "node:test";
import { selectRelease, validateUpdateInfo, allowedUpdateURL, newerPreview, type DesktopRelease } from "./update-release";

const version = "0.1.1-preview.3";
const tag = `v${version}`;
const root = `https://github.com/do-service/chat-apps/releases/download/${tag}/`;
const filename = `chat-desktop-${version}-win-x64.exe`;
const sha512 = Buffer.alloc(64, 42).toString("base64");
function release(assets = ["preview.yml", filename]) {
  return { tag_name: tag, draft: false, prerelease: true, assets: assets.map((name) => ({ name, size: 2048, browser_download_url: root + name })) };
}
function selected(): DesktopRelease {
  const result = selectRelease([release()], "win32", "x64", "0.1.0", true); assert.ok(result); return result;
}

test("only a strictly newer exact preview semver is eligible", () => {
  for (const value of [version, "1.0.0-preview.1", "0.2.0-preview.1"]) assert.equal(newerPreview(value, "0.1.0"), true);
  for (const value of ["0.1.0-preview.9", "0.1.1-beta.1", "0.1.1", "v0.1.1-preview.3", "0.1.1-preview.03", "0.1.1-preview.9007199254740992", "1.0.0-preview.1/../../evil"]) {
    assert.equal(newerPreview(value, "0.1.0"), false, value);
  }
  assert.equal(newerPreview(version, version), false);
  assert.equal(newerPreview("0.1.1-preview.2", version), false);
});

test("selects fixed repo preview asset for platform/arch, skips mobile or incomplete releases", () => {
  assert.equal(selected().asset.name, filename);
  assert.equal(selectRelease([release(["android-update.json"])], "win32", "x64", "0.1.0", true), null);
  assert.equal(selectRelease([release([filename])], "win32", "x64", "0.1.0", true), null);
  assert.equal(selectRelease([release()], "win32", "arm64", "0.1.0", true), null);
  assert.equal(selectRelease([release()], "linux", "x64", "0.1.0", true), null);
  for (const value of [{ ...release(), draft: true }, { ...release(), prerelease: false }, { ...release(), tag_name: "v0.1.1-beta.3" }]) {
    assert.equal(selectRelease([value], "win32", "x64", "0.1.0", true), null);
  }
  const linux = release([`chat-desktop-${version}-linux-x86_64.AppImage`, "preview-linux.yml"]);
  assert.ok(selectRelease([linux], "linux", "x64", "0.1.0", true));
  for (const arch of ["arm64", "x64"]) {
    const dmg = release([`chat-desktop-${version}-mac-${arch}.dmg`]);
    assert.ok(selectRelease([dmg], "darwin", arch, "0.1.0", false));
    assert.equal(selectRelease([dmg], "darwin", arch === "arm64" ? "x64" : "arm64", "0.1.0", false), null);
  }
});

test("rejects arbitrary release URLs, excessive assets, malformed tags and oversized installers", () => {
  for (const mutate of [
    (r: ReturnType<typeof release>) => { r.assets[1].browser_download_url = "https://evil.example/installer.exe"; },
    (r: ReturnType<typeof release>) => { r.assets[1].size = 2 ** 40; },
    (r: ReturnType<typeof release>) => { r.tag_name = "../evil"; },
    (r: ReturnType<typeof release>) => { r.assets.push(...Array.from({ length: 130 }, () => r.assets[0])); },
  ]) {
    const value = release(); mutate(value); assert.equal(selectRelease([value], "win32", "x64", "0.1.0", true), null);
  }
});

test("YAML update info binds exact candidate version, safe basename, size and sha512, no web installer", () => {
  const source = { version, files: [{ url: filename, sha512, size: 2048 }], path: filename, sha512 };
  assert.deepEqual(validateUpdateInfo(source, selected()).files, source.files);
  for (const value of [null, {}, { ...source, version: "0.1.1-preview.2" },
    { ...source, packages: {} }, { ...source, files: [{ url: "../evil.exe", sha512, size: 2048 }] },
    { ...source, files: [{ url: root + filename, sha512, size: 2048 }] },
    { ...source, files: [{ url: filename, sha512: "bad", size: 2048 }] },
    { ...source, files: [{ url: filename, sha512, size: 2049 }] },
    { ...source, minimumSystemVersion: "evil" },
  ]) assert.throws(() => validateUpdateInfo(value, selected()), /Invalid update release/);
});

test("network allowlist is HTTPS only, exact fixed repo or GitHub release CDN, no userinfo/port", () => {
  for (const url of [root + filename, root + "preview.yml", "https://release-assets.githubusercontent.com/github-production-release-asset/1/asset?sig=fake"]) {
    assert.equal(allowedUpdateURL(url), true, url);
  }
  for (const url of ["http://github.com/do-service/chat-apps/releases", "https://github.com/evil/repo/releases/download/v1/a.exe", "https://github.com.evil.example/", "https://user:password@github.com/do-service/chat-apps/releases", "https://release-assets.githubusercontent.com:444/a", "file:///tmp/a", "https://release-assets.githubusercontent.com/../evil", "https://api.github.com/user"]) {
    assert.equal(allowedUpdateURL(url), false, url);
  }
});
