import { isBadgeCount } from "./contract";

const glyphs: Readonly<Record<string, readonly string[]>> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

export function badgeText(count: number): string {
  if (!isBadgeCount(count)) throw new Error("Invalid badge count");
  return count === 0 ? "" : count > 99 ? "99+" : String(count);
}

export interface BadgeBitmap {
  /** Opaque/transparent BGRA pixels for Electron createFromBitmap on Windows/Linux. */
  pixels: Buffer;
  width: number;
  height: number;
}

export function renderBadgeBitmap(count: number): BadgeBitmap | null {
  const text = badgeText(count);
  if (!text) return null;
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  // A fixed raster font avoids platform fonts, SVG decoding and renderer injection.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(3 - x, 0, x - 12);
      const dy = Math.max(3 - y, 0, y - 12);
      if (dx * dx + dy * dy > 9) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = 68; pixels[offset + 1] = 68; pixels[offset + 2] = 220; pixels[offset + 3] = 255;
    }
  }
  const scale = text.length < 3 ? 2 : 1;
  const left = Math.floor((size - (text.length * 4 - 1) * scale) / 2);
  const top = Math.floor((size - 5 * scale) / 2);
  for (let index = 0; index < text.length; index++) {
    const glyph = glyphs[text[index]];
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 3; column++) {
        if (glyph[row][column] !== "1") continue;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const offset = ((top + row * scale + y) * size + left + (index * 4 + column) * scale + x) * 4;
            pixels.fill(255, offset, offset + 4);
          }
        }
      }
    }
  }
  return { pixels, width: size, height: size };
}
