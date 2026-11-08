import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { FileMetadataStore } from "./notification-store";
import { MAX_JOURNAL_BYTES, MAX_NOTIFICATIONS, notificationGroupId, validateJournal, type NotificationMetadata } from "./notifications";

function temporaryDirectory(): { path: string; cleanup(): void } {
  const root = realpathSync(tmpdir());
  const path = mkdtempSync(join(root, "chat-notification-store-"));
  return { path, cleanup: () => {
    // Only delete the exact fresh test directory, never an unchecked computed path.
    assert.equal(dirname(realpathSync(path)), root);
    assert.ok(basename(path).startsWith("chat-notification-store-"));
    rmSync(path, { recursive: true });
  } };
}
function metadata(): NotificationMetadata {
  const value = { id: "event", accountId: "alice", kind: "message", route: { chatId: "chat" }, createdAt: 1_000, expiresAt: 2_000, osId: "0123456789abcdef", groupId: "" };
  const entry: NotificationMetadata = { ...value, kind: "message" };
  entry.groupId = notificationGroupId(entry);
  return entry;
}

test("atomic metadata journal projects only approved fields and restores a complete document", () => {
  const temp = temporaryDirectory();
  try {
    const store = new FileMetadataStore(temp.path);
    assert.equal(store.load(), undefined);
    const entry = { ...metadata(), title: "Secret title", body: "Secret body", token: "Secret credentials", path: "/unsafe" };
    store.save([entry]);
    assert.deepEqual(readdirSync(temp.path), ["notification-metadata-v1.json"]);
    const text = readFileSync(join(temp.path, "notification-metadata-v1.json"), "utf8");
    assert.equal(text.includes("Secret"), false);
    assert.equal(text.includes("/unsafe"), false);
    assert.deepEqual(validateJournal(store.load(), 1_000), [metadata()]);
    store.save([]);
    assert.deepEqual(validateJournal(store.load(), 1_000), []);
  } finally { temp.cleanup(); }
});

test("rejects relative paths, oversized/corrupt files, arrays over bound and symlink reads", () => {
  assert.throws(() => new FileMetadataStore("relative/path"), TypeError);
  const temp = temporaryDirectory();
  try {
    const journal = join(temp.path, "notification-metadata-v1.json");
    const store = new FileMetadataStore(temp.path);
    writeFileSync(journal, "x".repeat(MAX_JOURNAL_BYTES + 1));
    assert.equal(store.load(), undefined);
    writeFileSync(journal, "{broken");
    assert.equal(store.load(), undefined);
    assert.throws(() => store.save(Array.from({ length: MAX_NOTIFICATIONS + 1 }, metadata)), RangeError);
    if (process.platform !== "win32") {
      const linkedDirectory = join(temp.path, "linked");
      const linkedStore = new FileMetadataStore(linkedDirectory);
      linkedStore.save([]);
      const target = join(linkedDirectory, "notification-metadata-v1.json");
      // The resolved target is the just-created journal under this test directory.
      assert.equal(realpathSync(target), target);
      rmSync(target);
      symlinkSync(journal, target);
      assert.equal(linkedStore.load(), undefined);
    }
  } finally { temp.cleanup(); }
});
