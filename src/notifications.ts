import { createHash, randomBytes } from "node:crypto";
import {
  isIdentifier, isNotificationDismissal, isNotificationKey, isNotificationRequest, isRecord, isRoute,
  type DesktopEvent, type NotificationDismissal, type NotificationKey, type NotificationKind,
  type NotificationRequest, type NotificationResult, type NotificationRoute,
} from "./contract";

export const MAX_NOTIFICATIONS = 100;
export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
export const CALL_TTL_MS = 60 * 1000;
export const MAX_JOURNAL_BYTES = 128 * 1024;

export type NotificationMetadata = {
  id: string;
  accountId: string;
  kind: NotificationKind;
  route: NotificationRoute;
  createdAt: number;
  expiresAt: number;
  osId: string;
  groupId: string;
};
export type MetadataStore = {
  load(): unknown;
  save(entries: readonly NotificationMetadata[]): void;
};
export type NativeHandle = { close(): void };
export type NativeCallbacks = { click(): void; failed(): void };
export type NativeOptions = NotificationRequest & { osId: string; groupId: string };
export type NotificationNativePort = {
  supported(): boolean;
  create(options: NativeOptions, callbacks: NativeCallbacks): NativeHandle & { show(): void };
  subscribeActivation?(activate: (osId: string) => void): () => void;
  restore?(callbacks: (osId: string) => NativeCallbacks | undefined): Promise<void>;
  remove?(osId: string): void;
};
export type Schedule = (callback: () => void, delay: number) => () => void;
type Entry = { metadata: NotificationMetadata; handle?: NativeHandle; clicked: boolean };
type ServiceOptions = {
  native: NotificationNativePort;
  store?: MetadataStore;
  emit(event: DesktopEvent): void;
  onActivate?(): void;
  now?: () => number;
  schedule?: Schedule;
};

function key(value: NotificationKey): string {
  return `${value.accountId}:${value.id}`;
}
function opaque(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
export function notificationOsId(value: NotificationKey): string {
  // Per-delivery randomness prevents an old OS callback matching a reissued ID
  // after logout, clear, replacement or a process restart.
  return opaque(`notification:${key(value)}:${randomBytes(16).toString("hex")}`);
}
export function notificationGroupId(value: { accountId: string; kind: NotificationKind; route: NotificationRoute }): string {
  return opaque(`group:${value.accountId}:${value.kind}:${value.route.chatId}:${value.route.callId ?? ""}`);
}
function ttl(kind: NotificationKind): number {
  return kind === "call" ? CALL_TTL_MS : MESSAGE_TTL_MS;
}
function ownKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((name) => keys.includes(name));
}
function isMetadata(value: unknown, now: number): value is NotificationMetadata {
  if (!isRecord(value) || !ownKeys(value, ["id", "accountId", "kind", "route", "createdAt", "expiresAt", "osId", "groupId"])) return false;
  if (!isIdentifier(value.id) || !isIdentifier(value.accountId)
    || (value.kind !== "message" && value.kind !== "call" && value.kind !== "test") || !isRoute(value.route)
    || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || value.createdAt > now
    || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.createdAt
    || value.expiresAt - value.createdAt > ttl(value.kind)
    || typeof value.osId !== "string" || typeof value.groupId !== "string") return false;
  return /^[a-f0-9]{16}$/.test(value.osId)
    && value.groupId === notificationGroupId({ accountId: value.accountId, kind: value.kind, route: value.route });
}

// The complete document is rejected instead of partially trusting a corrupt journal.
export function validateJournal(value: unknown, now: number): NotificationMetadata[] {
  if (!isRecord(value) || !ownKeys(value, ["version", "entries"]) || value.version !== 1
    || !Array.isArray(value.entries) || value.entries.length > MAX_NOTIFICATIONS) return [];
  const entries: NotificationMetadata[] = [];
  const ids = new Set<string>();
  const groups = new Set<string>();
  const keys = new Set<string>();
  for (const item of value.entries) {
    if (!isMetadata(item, now) || ids.has(item.osId) || groups.has(item.groupId) || keys.has(key(item))) return [];
    ids.add(item.osId);
    groups.add(item.groupId);
    keys.add(key(item));
    if (item.expiresAt > now) entries.push({ ...item, route: { ...item.route } });
  }
  return entries;
}

// v45.2.3 windows_toast_activator.cc parses these literal key/value pairs.
// No arbitrary OS URL, JSON, reply text or action is a navigation capability.
export function parseWindowsActivation(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "click" || typeof value.arguments !== "string") return undefined;
  const match = /^type=click&tag=([a-f0-9]{16})$/.exec(value.arguments);
  return match?.[1];
}
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&apos;";
    }
  }).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
export function windowsToastXml(options: NativeOptions): string {
  if (!/^[a-f0-9]{16}$/.test(options.osId)) throw new TypeError("Invalid notification OS identifier");
  return `<toast launch="type=click&amp;tag=${options.osId}"><visual><binding template="ToastGeneric"><text>${escapeXml(options.title)}</text><text>${escapeXml(options.body)}</text></binding></visual>${options.silent ? '<audio silent="true"/>' : ""}</toast>`;
}
const defaultSchedule: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return () => clearTimeout(timer);
};

export class NotificationService {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private accountId: string | null = null;
  private accountBound = false;
  private ready = false;
  private disposed = false;
  private initialized = false;
  private cancelTimer: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  supported(): boolean {
    return !this.disposed && this.options.native.supported();
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    let restored: NotificationMetadata[] = [];
    try {
      restored = validateJournal(this.options.store?.load(), this.now());
    } catch {
      // Unreadable local metadata never becomes an activation capability.
    }
    if (!this.accountBound) {
      for (const metadata of restored) this.entries.set(key(metadata), { metadata, clicked: false });
    }
    // Native history may never settle (e.g. unsigned macOS). It must not
    // suspend expiry or prevent synchronous show/account/readiness operations.
    this.prune();
    this.armTimer();
    this.unsubscribe = this.options.native.subscribeActivation?.((osId) => this.activate(osId));
    try {
      await this.options.native.restore?.((osId) => {
        if (this.disposed) return undefined;
        const entry = this.byOsId(osId);
        if (!entry || entry.metadata.expiresAt <= this.now()
          || (this.accountBound && entry.metadata.accountId !== this.accountId)) return undefined;
        return this.callbacks(entry);
      });
    } catch {
      // History is best effort; journal matching still bounds central activation.
    }
    if (this.disposed) return;
    this.prune();
    this.armTimer();
  }

  setAccount(accountId: string | null): void {
    if (accountId !== null && !isIdentifier(accountId)) throw new TypeError("Invalid account identifier");
    if (this.disposed) return;
    const changed = this.accountBound && this.accountId !== accountId;
    this.accountBound = true;
    this.accountId = accountId;
    for (const entry of this.entries.values()) {
      if (changed || accountId === null || entry.metadata.accountId !== accountId) this.removeEntry(entry);
    }
    this.persist();
    this.flush();
    this.armTimer();
  }

  setReady(ready: boolean): void {
    this.ready = ready;
    if (ready) this.flush();
  }

  show(request: NotificationRequest): NotificationResult {
    if (!isNotificationRequest(request)) throw new TypeError("Invalid notification request");
    if (this.disposed || !this.initialized) return { accepted: false, reason: "failed" };
    this.prune();
    if (!this.accountBound || request.accountId !== this.accountId) return { accepted: false, reason: "account-mismatch" };
    const now = this.now();
    if (request.expiresAt <= now) return { accepted: false, reason: "expired" };
    if (!this.supported()) {
      this.options.emit({ type: "notification-error", id: request.id, code: "unsupported" });
      return { accepted: false, reason: "unsupported" };
    }
    if (this.entries.has(key(request))) return { accepted: false, reason: "duplicate" };
    const metadata: NotificationMetadata = {
      id: request.id, accountId: request.accountId, kind: request.kind, route: { ...request.route },
      createdAt: now, expiresAt: Math.min(request.expiresAt, now + ttl(request.kind)),
      osId: notificationOsId(request), groupId: notificationGroupId(request),
    };
    if (this.byOsId(metadata.osId)) return { accepted: false, reason: "limit" };
    const previous = Array.from(this.entries.values()).find((entry) => entry.metadata.groupId === metadata.groupId);
    if (!previous && this.entries.size >= MAX_NOTIFICATIONS) return { accepted: false, reason: "limit" };
    if (previous) this.removeEntry(previous);
    const entry: Entry = { metadata, clicked: false };
    this.entries.set(key(metadata), entry);
    try {
      // Commit only metadata before exposing the notification to a cold-start click.
      this.persist();
      const handle = this.options.native.create({ ...request, route: { ...request.route }, expiresAt: metadata.expiresAt, osId: metadata.osId, groupId: metadata.groupId }, this.callbacks(entry));
      entry.handle = handle;
      handle.show();
      this.armTimer();
      return this.entries.get(key(metadata)) === entry ? { accepted: true } : { accepted: false, reason: "failed" };
    } catch {
      this.fail(entry);
      return { accepted: false, reason: "failed" };
    }
  }

  close(value: NotificationKey): void {
    if (!isNotificationKey(value)) throw new TypeError("Invalid notification key");
    if (value.accountId !== this.accountId || this.disposed) return;
    const entry = this.entries.get(key(value));
    if (entry) this.removeEntry(entry);
    this.persist();
    this.armTimer();
  }

  dismiss(selector: NotificationDismissal): void {
    if (!isNotificationDismissal(selector)) throw new TypeError("Invalid notification dismissal");
    if (selector.accountId !== this.accountId || this.disposed) return;
    for (const entry of this.entries.values()) {
      const metadata = entry.metadata;
      if (metadata.accountId !== selector.accountId || metadata.kind !== selector.kind) continue;
      if (selector.kind === "message") {
        const match = /^message-([0-9]+)$/.exec(metadata.id);
        const messageId = match ? Number(match[1]) : NaN;
        if (metadata.route.chatId !== selector.chatId || !Number.isSafeInteger(messageId)
          || messageId > selector.throughMessageId) continue;
      } else if ("callId" in selector) {
        if (metadata.route.callId !== selector.callId) continue;
      } else if (metadata.route.callId !== undefined && selector.exceptCallIds.includes(metadata.route.callId)) {
        continue;
      }
      // Registry removal precedes best-effort OS close: pending and late clicks lose authority immediately.
      this.removeEntry(entry);
    }
    this.persist();
    this.armTimer();
  }

  clear(): void {
    for (const entry of this.entries.values()) this.removeEntry(entry);
    this.persist();
    this.armTimer();
  }

  // Quit preserves delivered metadata; it is not logout or durable event delivery.
  dispose(): void {
    this.disposed = true;
    this.ready = false;
    this.cancelTimer?.();
    this.unsubscribe?.();
    this.entries.clear();
  }

  private byOsId(osId: string): Entry | undefined {
    return Array.from(this.entries.values()).find((entry) => entry.metadata.osId === osId);
  }
  private callbacks(entry: Entry): NativeCallbacks {
    return { click: () => this.activate(entry.metadata.osId, entry), failed: () => this.fail(entry) };
  }
  private activate(osId: string, expected?: Entry): void {
    if (this.disposed) return;
    this.prune();
    const entry = this.byOsId(osId);
    if (!entry || (expected && entry !== expected) || entry.clicked
      || (this.accountBound && entry.metadata.accountId !== this.accountId)) return;
    entry.clicked = true;
    this.options.onActivate?.();
    this.flush();
  }
  private flush(): void {
    if (!this.ready || !this.accountBound || this.accountId === null || this.disposed) return;
    this.prune();
    for (const entry of this.entries.values()) {
      if (!entry.clicked || entry.metadata.accountId !== this.accountId) continue;
      const metadata = entry.metadata;
      this.removeEntry(entry);
      try { this.persist(); } catch {
        // An OS callback must not leak a filesystem exception into main or
        // navigate when consumption could not be committed.
        this.options.emit({ type: "notification-error", id: metadata.id, code: "failed" });
        continue;
      }
      // Account binding comes from the trusted page, not backend authentication (D4).
      this.options.emit({ type: "activation", id: metadata.id, accountId: metadata.accountId, route: { ...metadata.route } });
    }
    this.armTimer();
  }
  private fail(entry: Entry): void {
    if (this.disposed || this.entries.get(key(entry.metadata)) !== entry) return;
    this.removeEntry(entry);
    try { this.persist(); } catch { /* Report only the bounded diagnostic below. */ }
    this.options.emit({ type: "notification-error", id: entry.metadata.id, code: "failed" });
    this.armTimer();
  }
  private removeEntry(entry: Entry): void {
    this.entries.delete(key(entry.metadata));
    try { entry.handle?.close(); } catch { /* OS removal is best effort. */ }
    try { this.options.native.remove?.(entry.metadata.osId); } catch { /* OS removal is best effort. */ }
  }
  private prune(): void {
    const expired: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.metadata.expiresAt <= this.now()) {
        this.removeEntry(entry);
        expired.push(entry.metadata.id);
      }
    }
    if (expired.length > 0) {
      try { this.persist(); } catch {
        // Keep the in-memory registry fail-closed even if disk cleanup fails.
        for (const id of expired) this.options.emit({ type: "notification-error", id, code: "failed" });
      }
    }
  }
  private persist(): void {
    this.options.store?.save(Array.from(this.entries.values(), (entry) => ({ ...entry.metadata, route: { ...entry.metadata.route } })));
  }
  private armTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.disposed || this.entries.size === 0) return;
    const earliest = Math.min(...Array.from(this.entries.values(), (entry) => entry.metadata.expiresAt));
    this.cancelTimer = this.schedule(() => {
      try { this.prune(); } finally { this.armTimer(); }
    }, Math.max(1, earliest - this.now()));
  }
}
