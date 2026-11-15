import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fsyncSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { installAppImage, updateCacheFailure, verifyCachedInstaller, writableAppImage } from "./update-files";

function fixture() {
  const parent = realpathSync(tmpdir()); const directory = mkdtempSync(join(parent, "chat-atomic-update-"));
  const image = join(directory, "Chat.AppImage"); const installer = join(directory, "cache.AppImage");
  const previous = Buffer.alloc(128, 1); const next = Buffer.alloc(256, 2);
  for (const bytes of [previous, next]) {
    Buffer.from([127, 69, 76, 70, 2, 1, 1, 0, 65, 73, 2]).copy(bytes);
    bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52);
  }
  writeFileSync(image, previous, { mode: 0o700 }); writeFileSync(installer, next, { mode: 0o700 });
  const integrity = { size: next.length, sha512: createHash("sha512").update(next).digest("base64") };
  return { directory, image, installer, integrity, previous, next,
    cleanup() { const target = realpathSync(directory); assert.equal(target, directory); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith("chat-atomic-update-")); rmSync(target, { recursive: true }); } };
}

test("AppImage policy rejects symlinks, wrong magic and relative paths", async (t) => {
  const f = fixture();
  try {
    assert.equal(writableAppImage(f.image), true);
    const link = join(f.directory, "Link.AppImage"); symlinkSync(f.image, link);
    for (const value of [undefined, "relative.AppImage", f.directory, link, f.image + "\0"]) assert.equal(writableAppImage(value), false);
    await t.test("POSIX executable permission is required", { skip: process.platform === "win32" && "Windows access(X_OK) does not enforce POSIX execute bits" }, () => {
      chmodSync(f.image, 0o600); assert.equal(writableAppImage(f.image), false);
      chmodSync(f.image, 0o700); assert.equal(writableAppImage(f.image), true);
    });
    writeFileSync(f.image, "not-an-AppImage"); assert.equal(writableAppImage(f.image), false);
  } finally { f.cleanup(); }
});

// These real-filesystem AppImage transactions exercise POSIX directory fsync, unavailable on Windows.
// createElectronUpdatePort selects this installer only for Linux, never for the Windows NSIS path.
const posixAppImageInstall = { skip: process.platform === "win32" && "AppImage installation requires POSIX directory fsync; Windows uses NSIS" };

test("atomic AppImage install preserves its path, verifies copied bytes and retains no ordinary staging", posixAppImageInstall, () => {
  const f = fixture();
  try {
    const launches: string[] = [];
    installAppImage(f.image, f.installer, f.integrity, (path) => { assert.deepEqual(readFileSync(path), f.next); launches.push(path); });
    assert.deepEqual(readFileSync(f.image), f.next); assert.deepEqual(launches, [f.image]);
    assert.deepEqual(readdirSync(f.directory).sort(), ["Chat.AppImage", "cache.AppImage"]);
  } finally { f.cleanup(); }
});

test("missing, wrong-size or wrong-hash cache never removes the installed AppImage and is redownloadable", () => {
  const f = fixture();
  try {
    verifyCachedInstaller(f.installer, f.integrity);
    for (const [path, integrity] of [[join(f.directory, "missing.AppImage"), f.integrity], [f.installer, { ...f.integrity, size: 1 }], [f.installer, { ...f.integrity, sha512: Buffer.alloc(64).toString("base64") }]] satisfies Array<[string, typeof f.integrity]>) {
      assert.throws(() => verifyCachedInstaller(path, integrity), updateCacheFailure);
      assert.throws(() => installAppImage(f.image, path, integrity, () => { throw new Error("must not launch"); }), updateCacheFailure);
      assert.deepEqual(readFileSync(f.image), f.previous);
    }
  } finally { f.cleanup(); }
});

test("hash-bound but wrong-architecture or non-AppImage cache is rejected before replacement", () => {
  for (const invalid of ["architecture", "magic", "class", "type"]) {
    const f = fixture();
    try {
      const bytes = Buffer.from(f.next);
      if (invalid === "architecture") bytes.writeUInt16LE(183, 18);
      if (invalid === "magic") bytes[8] = 0;
      if (invalid === "class") bytes[4] = 1;
      if (invalid === "type") bytes.writeUInt16LE(1, 16);
      writeFileSync(f.installer, bytes);
      const integrity = { size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") };
      assert.throws(() => installAppImage(f.image, f.installer, integrity, () => { throw new Error("must not launch"); }), updateCacheFailure);
      assert.deepEqual(readFileSync(f.image), f.previous);
    } finally { f.cleanup(); }
  }
});

test("same-directory rename/link/fsync failures preserve the previous binary; relaunch failure restores it", posixAppImageInstall, () => {
  for (const failure of ["rename", "link", "sync", "relaunch"]) {
    const f = fixture();
    try {
      const failed = () => { throw new Error("synthetic storage failure"); };
      assert.throws(() => installAppImage(f.image, f.installer, f.integrity, failure === "relaunch" ? failed : () => {}, {
        rename: failure === "rename" ? failed : renameSync, link: failure === "link" ? failed : linkSync, sync: failure === "sync" ? failed : fsyncSync,
      }));
      assert.equal(existsSync(f.image), true); assert.deepEqual(readFileSync(f.image), f.previous);
    } finally { f.cleanup(); }
  }
});

test("failed rollback retains the previous hardlinked binary and never deletes the replacement", posixAppImageInstall, () => {
  const f = fixture();
  try {
    assert.throws(() => installAppImage(f.image, f.installer, f.integrity, () => { throw new Error("synthetic relaunch failure"); }, {
      rename: (source, destination) => { if (typeof source === "string" && source.endsWith("previous.AppImage")) throw new Error("synthetic restore failure"); renameSync(source, destination); },
      link: linkSync, sync: fsyncSync,
    }));
    assert.deepEqual(readFileSync(f.image), f.next);
    const work = readdirSync(f.directory).find((name) => name.startsWith(".chat-update-")); assert.ok(work);
    assert.deepEqual(readFileSync(join(f.directory, work, "previous.AppImage")), f.previous);
  } finally { f.cleanup(); }
});
