import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dump } from "js-yaml";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { prepareArtifacts } from "./artifacts.mjs";

async function fixture(t, platform = "windows") {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-preview-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("desktop-preview-test-"));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "release"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.1-preview.3" }));
  const name = `chat-desktop-spike-0.1.1-preview.3-${platform === "windows" ? "win-x64.exe" : "linux-x86_64.AppImage"}`;
  const payload = Buffer.from("clearly synthetic installer fixture, not an executable");
  const map = { version: "2", files: [{ name: "file", offset: 0, sizes: [payload.length], checksums: [Buffer.from(blake2b(payload, { dkLen: 18 })).toString("base64")] }] };
  const compressed = (platform === "windows" ? gzipSync : deflateRawSync)(JSON.stringify(map));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(compressed.length);
  const bytes = platform === "windows" ? payload : Buffer.concat([payload, compressed, header]);
  await writeFile(path.join(root, "release", name), bytes);
  if (platform === "windows") await writeFile(path.join(root, "release", `${name}.blockmap`), compressed);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const metadata = { version: "0.1.1-preview.3", files: [{ url: name, sha512, size: bytes.length, ...(platform === "linux" ? { blockMapSize: compressed.length } : {}) }], path: name, sha512, releaseDate: "2026-11-12T12:00:00.000Z" };
  const yaml = platform === "windows" ? "preview.yml" : "preview-linux.yml";
  const save = () => writeFile(path.join(root, "release", yaml), JSON.stringify(metadata));
  await save();
  return { root, name, yaml, metadata, map, save };
}

for (const platform of ["windows", "linux"]) {
  test(`${platform}: preview allowlist binds metadata, exact binary and blockmap`, async t => {
    const { root, name, yaml } = await fixture(t, platform);
    await writeFile(path.join(root, "release", "private.yml"), "not published");
    const names = [name, ...(platform === "windows" ? [`${name}.blockmap`] : []), yaml];
    assert.deepEqual(await prepareArtifacts(root, platform, { preview: true }), names.map(name => `release/${name}`).concat("release/SHA256SUMS.txt"));
    const sums = (await readFile(path.join(root, "release/SHA256SUMS.txt"), "utf8")).trim().split("\n");
    assert.equal(sums.length, names.length);
    for (const line of sums) {
      const [digest, file] = line.split("  ");
      assert.equal(digest, createHash("sha256").update(await readFile(path.join(root, "release", file))).digest("hex"));
    }
  });
}

for (const [name, mutate] of [
  ["wrong version", value => { value.version = "0.1.1-preview.1"; }],
  ["wrong asset", value => { value.files[0].url = "other.exe"; }],
  ["absolute URL", value => { value.files[0].url = "https://example.test/private.exe"; }],
  ["traversal", value => { value.path = "../private.exe"; }],
  ["wrong hash", value => { value.files[0].sha512 = "A".repeat(86) + "=="; }],
  ["legacy hash mismatch", value => { value.sha512 = "A".repeat(86) + "=="; }],
  ["wrong size", value => { value.files[0].size++; }],
  ["extra asset", value => { value.files.push({ ...value.files[0] }); }],
  ["private extra field", value => { value.releaseNotes = "private source"; }],
  ["extra file field", value => { value.files[0].headers = { Authorization: "synthetic" }; }],
  ["invalid release date", value => { value.releaseDate = "private data"; }],
]) {
  test(`preview rejects ${name} before creating checksums`, async t => {
    const f = await fixture(t);
    mutate(f.metadata);
    await f.save();
    await assert.rejects(prepareArtifacts(f.root, "windows", { preview: true }), /preview|metadata|hash|asset|size/i);
    await assert.rejects(readFile(path.join(f.root, "release/SHA256SUMS.txt")), { code: "ENOENT" });
  });
}

test("preview requires its exact YAML and rejects duplicate keys and aliases", async t => {
  const f = await fixture(t);
  for (const text of ["version: a\nversion: b\n", "version: &anchor abc\nfiles: *anchor\n", "!unsupported private", "x".repeat(65537)]) {
    await writeFile(path.join(f.root, "release", f.yaml), text);
    await assert.rejects(prepareArtifacts(f.root, "windows", { preview: true }));
  }
});

test("preview rejects symlink metadata and altered blockmap chunks", async t => {
  const f = await fixture(t);
  f.map.files[0].checksums[0] = "A".repeat(24);
  await writeFile(path.join(f.root, "release", `${f.name}.blockmap`), gzipSync(JSON.stringify(f.map)));
  await assert.rejects(prepareArtifacts(f.root, "windows", { preview: true }), /blockmap/i);
  if (process.platform !== "win32") {
    const target = path.join(f.root, "other");
    await mkdir(target);
    await writeFile(path.join(target, "package.json"), JSON.stringify({ version: "0.1.1-preview.3" }));
    await mkdir(path.join(target, "release"));
    for (const name of [f.name, `${f.name}.blockmap`, f.yaml]) await symlink(path.join(f.root, "release", name), path.join(target, "release", name));
    await assert.rejects(prepareArtifacts(target, "windows", { preview: true }), /regular file/i);
  }
});

for (const platform of ["windows", "linux"]) {
  test(`${platform}: verifies actual pinned builder multi-chunk blockmap and generated YAML`, async t => {
    const f = await fixture(t, platform);
    const filename = path.join(f.root, "release", f.name);
    await writeFile(filename, Buffer.alloc(131072, 0x5a));
    const info = await buildBlockMap(filename, platform === "windows" ? "gzip" : "deflate", platform === "windows" ? `${filename}.blockmap` : undefined);
    f.metadata.files[0] = { url: f.name, ...info };
    f.metadata.sha512 = info.sha512;
    await writeFile(path.join(f.root, "release", f.yaml), dump(f.metadata));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./artifacts.mjs", import.meta.url)), platform, "--preview"], { cwd: f.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`release/${f.yaml}\n`));
    assert.ok(result.stdout.endsWith("release/SHA256SUMS.txt\n"));
  });
}

test("macOS preview remains exactly two manual DMGs, never ZIP or updater YAML", async t => {
  const f = await fixture(t);
  const names = ["arm64", "x64"].map(arch => `chat-desktop-spike-0.1.1-preview.3-mac-${arch}.dmg`);
  for (const name of names) await writeFile(path.join(f.root, "release", name), "synthetic DMG fixture");
  await writeFile(path.join(f.root, "release/preview-mac.yml"), "not published");
  await writeFile(path.join(f.root, "release/private.zip"), "not published");
  assert.deepEqual(await prepareArtifacts(f.root, "macos", { preview: true }), names.map(name => `release/${name}`).concat("release/SHA256SUMS.txt"));
});

test("preview rejects corrupt compressed blockmap without leaking its content", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "release", `${f.name}.blockmap`), "synthetic private invalid gzip");
  await assert.rejects(prepareArtifacts(f.root, "windows", { preview: true }), error => error.message === "Invalid preview blockmap encoding");
});

test("preview rejects corrupted embedded AppImage blockmap", async t => {
  const f = await fixture(t, "linux");
  f.metadata.files[0].blockMapSize++;
  await f.save();
  await assert.rejects(prepareArtifacts(f.root, "linux", { preview: true }), /blockmap/i);
});
