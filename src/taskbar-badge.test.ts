import assert from "node:assert/strict";
import test from "node:test";
import { badgeText, renderBadgeBitmap } from "./taskbar-badge";

test("badge text keeps exact 1..99, caps larger counts, and clears zero", () => {
  assert.equal(badgeText(0), "");
  for (let count = 1; count <= 99; count++) assert.equal(badgeText(count), String(count));
  for (const count of [100, 101, 999999]) assert.equal(badgeText(count), "99+");
  assert.equal(renderBadgeBitmap(0), null);
});

test("badge renderer rejects invalid counts before allocating a bitmap", () => {
  for (const count of [-1, 1.5, NaN, Infinity, 1000000, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => badgeText(count), /Invalid badge count/u);
    assert.throws(() => renderBadgeBitmap(count), /Invalid badge count/u);
  }
});

test("badge bitmap is deterministic 16x16 BGRA with transparent corners and opaque red/white pixels", () => {
  const bitmap = renderBadgeBitmap(8); assert.ok(bitmap);
  assert.equal(bitmap.width, 16); assert.equal(bitmap.height, 16);
  assert.equal(bitmap.pixels.length, 16 * 16 * 4);
  assert.deepEqual([...bitmap.pixels.subarray(0, 4)], [0, 0, 0, 0]);
  const colors = new Set<string>();
  for (let offset = 0; offset < bitmap.pixels.length; offset += 4) {
    colors.add([...bitmap.pixels.subarray(offset, offset + 4)].join(","));
  }
  assert.deepEqual(colors, new Set(["0,0,0,0", "68,68,220,255", "255,255,255,255"]));
  assert.deepEqual(renderBadgeBitmap(8), bitmap);
  bitmap.pixels.fill(0);
  assert.notDeepEqual(renderBadgeBitmap(8), bitmap, "callers never mutate shared raster state");
});

test("every numeral has distinct raster glyphs and 99+ includes a visible plus", () => {
  const rasters = new Set<string>();
  for (let count = 1; count <= 99; count++) {
    const bitmap = renderBadgeBitmap(count); assert.ok(bitmap);
    rasters.add(bitmap.pixels.toString("hex"));
  }
  assert.equal(rasters.size, 99);
  const capped = renderBadgeBitmap(100); assert.ok(capped);
  assert.deepEqual(renderBadgeBitmap(999999), capped);
  assert.notDeepEqual(renderBadgeBitmap(99), capped);
  // Three 3x5 glyphs occupy x=2..12, y=5..9; the plus has a white centre.
  const plusCenter = (7 * capped.width + 11) * 4;
  assert.deepEqual([...capped.pixels.subarray(plusCenter, plusCenter + 4)], [255, 255, 255, 255]);
});
