import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "./contract";
import { validateAppURL } from "./security";

const maxSelectionBytes = 16_384;

export function readServerSelection(path: string): string | null {
  if (!isAbsolute(path)) throw new TypeError("Server selection path must be absolute");
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
  let text: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Server selection must be a regular file");
    if (stat.size > maxSelectionBytes) return null;
    const buffer = Buffer.alloc(maxSelectionBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxSelectionBytes) return null;
    text = buffer.toString("utf8", 0, length);
  } finally { closeSync(descriptor); }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.version !== 1 || Object.keys(value).length !== 2) return null;
    return validateAppURL(value.url);
  } catch { return null; }
}

export function writeServerSelection(path: string, url: string): void {
  if (!isAbsolute(path)) throw new TypeError("Server selection path must be absolute");
  const canonicalURL = validateAppURL(url);
  // The caller supplies a main-owned filename in existing userData, never a renderer path.
  const target = resolve(path);
  const directory = dirname(target);
  const temporary = join(directory, `.server-selection-${randomBytes(16).toString("hex")}.tmp`);
  if (dirname(temporary) !== directory || temporary === target) throw new Error("Invalid temporary selection path");
  let created = false;
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      writeFileSync(descriptor, JSON.stringify({ version: 1, url: canonicalURL }), "utf8");
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, target);
    created = false;
  } finally {
    // Only the exact sibling file successfully created by this call can be removed.
    if (created) unlinkSync(temporary);
  }
}
