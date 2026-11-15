import { createHash } from "node:crypto";
import {
  accessSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync,
  readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MAX_INSTALLER_BYTES } from "./update-release";

export type InstallerIntegrity = { size: number; sha512: string };
export function updateCacheFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_UPDATE_CACHE_INVALID";
}
function invalidCache(): Error { return Object.assign(new Error("Verified update cache is unavailable"), { code: "ERR_UPDATE_CACHE_INVALID" }); }
function appImageHeader(descriptor: number): boolean {
  const header = Buffer.alloc(64);
  return readSync(descriptor, header, 0, header.length, 0) === header.length
    && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    && header[4] === 2 && header[5] === 1 && header[6] === 1
    && header[8] === 65 && header[9] === 73 && header[10] === 2
    && (header.readUInt16LE(16) === 2 || header.readUInt16LE(16) === 3)
    && header.readUInt16LE(18) === 62 && header.readUInt32LE(20) === 1 && header.readUInt16LE(52) === 64;
}
export function writableAppImage(path: string | undefined): boolean {
  if (!path || !isAbsolute(path) || !path.endsWith(".AppImage") || path.includes("\0")) return false;
  let descriptor: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || realpathSync(path) !== resolve(path) || (process.getuid && stat.uid !== process.getuid())) return false;
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    accessSync(dirname(path), constants.W_OK | constants.X_OK);
    descriptor = openSync(path, "r");
    return appImageHeader(descriptor);
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function openInstaller(path: string | null, integrity: InstallerIntegrity): number {
  let descriptor: number | undefined;
  try {
    if (!path || !isAbsolute(path) || !Number.isSafeInteger(integrity.size) || integrity.size <= 0 || integrity.size > MAX_INSTALLER_BYTES
      || !/^[A-Za-z0-9+/]{86}==$/.test(integrity.sha512) || !lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) throw invalidCache();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== integrity.size) throw invalidCache();
    return descriptor;
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    throw invalidCache();
  }
}
function consumeInstaller(descriptor: number, integrity: InstallerIntegrity, copy?: (chunk: Buffer) => void): void {
  const digest = createHash("sha512"); const buffer = Buffer.alloc(64 * 1024); let total = 0;
  while (true) {
    const length = readSync(descriptor, buffer, 0, buffer.length, null);
    if (length === 0) break;
    total += length; if (total > integrity.size) throw invalidCache();
    const chunk = buffer.subarray(0, length); digest.update(chunk); copy?.(chunk);
  }
  if (total !== integrity.size || digest.digest("base64") !== integrity.sha512) throw invalidCache();
}
export function verifyCachedInstaller(path: string | null, integrity: InstallerIntegrity): void {
  const descriptor = openInstaller(path, integrity);
  try { consumeInstaller(descriptor, integrity); } finally { closeSync(descriptor); }
}
type AtomicFiles = { rename: typeof renameSync; link: typeof linkSync; sync: typeof fsyncSync };
const atomicFiles: AtomicFiles = { rename: renameSync, link: linkSync, sync: fsyncSync };

export function installAppImage(
  image: string | undefined, installer: string | null, integrity: InstallerIntegrity, relaunch: (path: string) => void,
  files: AtomicFiles = atomicFiles,
): void {
  if (!image || !writableAppImage(image)) throw new Error("AppImage installation is unsupported");
  const original = lstatSync(image);
  const source = openInstaller(installer, integrity);
  let work: string | undefined; let staged: string | undefined; let backup: string | undefined;
  let destination: number | undefined; let parent: number | undefined; let replaced = false; let retainedBackup = false;
  try {
    if (!appImageHeader(source)) throw invalidCache();
    work = mkdtempSync(join(dirname(image), ".chat-update-"));
    staged = join(work, "verified.AppImage"); backup = join(work, "previous.AppImage");
    destination = openSync(staged, "wx", original.mode & 0o777);
    consumeInstaller(source, integrity, (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(destination ?? -1, chunk, offset, chunk.length - offset);
        if (written === 0) throw new Error("AppImage staging write failed"); offset += written;
      }
    });
    files.sync(destination); closeSync(destination); destination = undefined;
    const current = lstatSync(image);
    if (current.ino !== original.ino || current.dev !== original.dev || !current.isFile()) throw new Error("AppImage changed during installation");
    files.link(image, backup);
    parent = openSync(dirname(image), "r"); files.sync(parent);
    // Stage and target share a filesystem: replacement is atomic and never unlinks the installed image first.
    files.rename(staged, image); replaced = true; files.sync(parent);
    relaunch(image);
  } catch (error) {
    if (replaced && backup) {
      try { files.rename(backup, image); if (parent !== undefined) files.sync(parent); }
      catch { retainedBackup = true; }
    }
    throw error;
  } finally {
    closeSync(source); if (destination !== undefined) closeSync(destination); if (parent !== undefined) closeSync(parent);
    // A failed restore retains the previous image for manual recovery rather than deleting the last backup.
    if (!retainedBackup) {
      for (const path of [staged, backup]) { if (path) try { unlinkSync(path); } catch { /* Private staging cleanup is best effort. */ } }
      if (work) try { rmdirSync(work); } catch { /* Never recursively delete an unexpected entry. */ }
    }
  }
}
