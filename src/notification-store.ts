import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MAX_JOURNAL_BYTES, MAX_NOTIFICATIONS, type MetadataStore, type NotificationMetadata } from "./notifications";

// The directory is supplied only by main from userData + a trusted origin profile.
// Renderer payloads never influence either filename or directory.
export class FileMetadataStore implements MetadataStore {
  private readonly journal: string;
  private readonly temporary: string;

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new TypeError("Metadata directory must be absolute");
    this.journal = join(directory, "notification-metadata-v1.json");
    this.temporary = join(directory, "notification-metadata-v1.tmp");
  }

  load(): unknown {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length > MAX_JOURNAL_BYTES) return undefined;
      const value: unknown = JSON.parse(buffer.toString("utf8", 0, length));
      return value;
    } catch {
      return undefined;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  save(entries: readonly NotificationMetadata[]): void {
    if (entries.length > MAX_NOTIFICATIONS) throw new RangeError("Metadata entry limit exceeded");
    // Explicit projection is a second boundary against accidental content persistence.
    const text = JSON.stringify({ version: 1, entries: entries.map((entry) => ({
      id: entry.id, accountId: entry.accountId, kind: entry.kind,
      route: { chatId: entry.route.chatId, ...(entry.route.callId === undefined ? {} : { callId: entry.route.callId }) },
      createdAt: entry.createdAt, expiresAt: entry.expiresAt, osId: entry.osId, groupId: entry.groupId,
    })) });
    if (Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES) throw new RangeError("Metadata byte limit exceeded");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const descriptor = openSync(this.temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error("Invalid metadata temporary file");
      writeFileSync(descriptor, text, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    // Same-directory rename publishes a complete journal, never partial JSON.
    renameSync(this.temporary, this.journal);
  }
}
