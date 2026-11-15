import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { readServerSelection, writeServerSelection } from "./server-store";

function temporaryDirectory() {
  const root = realpathSync(tmpdir());
  const path = mkdtempSync(join(root, "chat-server-store-"));
  return { path, cleanup: () => {
    assert.equal(dirname(realpathSync(path)), root);
    assert.ok(basename(path).startsWith("chat-server-store-"));
    rmSync(path, { recursive: true });
  } };
}

test("missing/corrupt selections recover without rewriting, valid HTTPS roots canonicalize", () => {
  const temp = temporaryDirectory();
  try {
    const path = join(temp.path, "selection.json");
    assert.equal(readServerSelection(path), null);
    for (const text of ["{broken", "null", "[]", '{"version":2,"url":"https://example.com/"}',
      '{"version":1,"url":"http://example.com/"}', '{"version":1,"url":"https://example.com/path"}',
      '{"version":1,"url":42}', "x".repeat(20_000)]) {
      writeFileSync(path, text);
      assert.equal(readServerSelection(path), null, text.slice(0, 100));
      assert.equal(readFileSync(path, "utf8"), text);
    }
    writeFileSync(path, JSON.stringify({ version: 1, url: "https://EXAMPLE.com:443" }));
    assert.equal(readServerSelection(path), "https://example.com/");
  } finally { temp.cleanup(); }
});

test("writes atomically publish only a private canonical selection and replace previous value", () => {
  const temp = temporaryDirectory();
  try {
    const path = join(temp.path, "selection.json");
    writeServerSelection(path, "https://EXAMPLE.com:443");
    assert.equal(readServerSelection(path), "https://example.com/");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, url: "https://example.com/" });
    assert.deepEqual(readdirSync(temp.path), ["selection.json"]);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    writeServerSelection(path, "https://second.example:8443/");
    assert.equal(readServerSelection(path), "https://second.example:8443/");
    assert.throws(() => writeServerSelection(path, "https://second.example/path"));
    assert.equal(readServerSelection(path), "https://second.example:8443/");
  } finally { temp.cleanup(); }
});

test("I/O failures are surfaced, missing parent is not created and failed publication leaves no temporary file", () => {
  const temp = temporaryDirectory();
  try {
    const missing = join(temp.path, "missing", "selection.json");
    assert.throws(() => writeServerSelection(missing, "https://example.com/"));
    assert.deepEqual(readdirSync(temp.path), []);
    const target = join(temp.path, "directory");
    mkdirSync(target);
    writeFileSync(join(target, "selection.json"), "file");
    // A child of a regular file yields ENOTDIR on POSIX but ENOENT on Windows.
    // Reading an existing directory must fail on both, not recover as a missing selection.
    assert.throws(() => readServerSelection(target), (error: unknown) => error instanceof Error);
    assert.throws(() => writeServerSelection(target, "https://example.com/"));
    assert.deepEqual(readdirSync(temp.path), ["directory"]);
    assert.equal(readFileSync(join(target, "selection.json"), "utf8"), "file");
  } finally { temp.cleanup(); }
});

test("explicit origins reject paths, credentials, queries, whitespace and non-HTTPS without overwriting", () => {
  const temp = temporaryDirectory();
  try {
    const path = join(temp.path, "selection.json");
    writeServerSelection(path, "https://original.example/");
    const original = readFileSync(path, "utf8");
    for (const value of ["http://example.com/", "https://user:secret@example.com/", "https://example.com/path", "https://example.com/?q=1",
      "https://example.com/#fragment", " example.com ", "https://example.com/ ", "javascript:alert(1)", "https://example.com/\\\\evil"]) {
      assert.throws(() => writeServerSelection(path, value), value);
      assert.equal(readFileSync(path, "utf8"), original);
    }
    assert.throws(() => readServerSelection("relative.json"), TypeError);
    assert.throws(() => writeServerSelection("relative.json", "https://example.com/"), TypeError);
  } finally { temp.cleanup(); }
});

test("atomic write replaces a target symlink without following it", { skip: process.platform === "win32" }, () => {
  const temp = temporaryDirectory();
  try {
    const original = join(temp.path, "original.json");
    const target = join(temp.path, "selection.json");
    writeFileSync(original, "private original");
    symlinkSync(original, target);
    writeServerSelection(target, "https://example.com/");
    assert.equal(readFileSync(original, "utf8"), "private original");
    assert.equal(readServerSelection(target), "https://example.com/");
    assert.equal(realpathSync(target), target);
  } finally { temp.cleanup(); }
});

test("non-file reads fail visibly and publication failures preserve the target", () => {
  const temp = temporaryDirectory();
  try {
    const target = join(temp.path, "selection.json");
    mkdirSync(target);
    assert.throws(() => readServerSelection(target));
    assert.throws(() => writeServerSelection(target, "https://example.com/"));
    assert.deepEqual(readdirSync(temp.path), ["selection.json"]);
    if (process.platform !== "win32") {
      const linked = join(temp.path, "linked.json");
      symlinkSync(target, linked);
      assert.throws(() => readServerSelection(linked));
    }
  } finally { temp.cleanup(); }
});
