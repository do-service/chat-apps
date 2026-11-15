import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

// These are the reviewed color-logo assets, not newly generated platform variants.
const assets = [
  ["png", "6413bfe9d546e5225fc9256a0ecec48df3a1272ea4bdc91c15b8e000222a95d3"],
  ["ico", "e38ca88e1d5490f3dcbc3c3fa525f7fcb7b80fff3cb2f3a4eb1b2d018c0915c1"],
  ["icns", "1535d355994f8ee82da91384d2a29e04d5b4440f3e6051b5c8b06e7a62283693"],
];

for (const [extension, hash] of assets) {
  test(`packaged ${extension} retains the reviewed canonical color logo`, () => {
    const data = readFileSync(`build/icons/icon.${extension}`);
    assert.equal(createHash("sha256").update(data).digest("hex"), hash);
  });
}

test("canonical PNG is 512px and Windows ICO includes multiple PNG resolutions", () => {
  const png = readFileSync("build/icons/icon.png");
  assert.deepEqual(png.subarray(0, 8), pngSignature);
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  const ico = readFileSync("build/icons/icon.ico");
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.equal(count, 6);
  const sizes: number[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = ico[entry] || 256;
    assert.equal(ico[entry + 1] || 256, width);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset >= 6 + count * 16 && offset + length <= ico.length);
    const frame = ico.subarray(offset, offset + length);
    assert.deepEqual(frame.subarray(0, 8), pngSignature);
    assert.equal(frame.readUInt32BE(16), width);
    assert.equal(frame.readUInt32BE(20), width);
    sizes.push(width);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 256]);
});

test("all platform packages and runtime copy use the reviewed icon assets", () => {
  const config = readFileSync("electron-builder.yml", "utf8");
  for (const [platform, extension] of [["mac", "icns"], ["win", "ico"], ["linux", "png"]]) {
    const section = config.match(new RegExp(`^${platform}:\\n((?:[ \\t].*(?:\\n|$))*)`, "m"))?.[1];
    assert.ok(section, platform);
    assert.match(section, new RegExp(`^  icon: build/icons/icon\\.${extension}$`, "m"));
  }
  assert.match(config, /^  - dist\/\*\*$/m);
  const build = readFileSync("scripts/build.mjs", "utf8");
  assert.ok(build.includes('await cp(new URL("../build/icons/icon.png", import.meta.url), new URL("../dist/app-icon.png", import.meta.url))'));
});
