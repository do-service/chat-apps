import assert from "node:assert/strict";
import test from "node:test";
import type { NotificationConstructorOptions } from "electron";
import { createElectronNotificationPort } from "./electron-notifications";
import type { DesktopEvent, NotificationRequest } from "./contract";
import {
  CALL_TTL_MS, MAX_NOTIFICATIONS, MESSAGE_TTL_MS, NotificationService,
  notificationGroupId, parseWindowsActivation, validateJournal, windowsToastXml,
  type MetadataStore, type NativeCallbacks, type NativeOptions,
  type NotificationMetadata, type NotificationNativePort, type Schedule,
} from "./notifications";

class MemoryStore implements MetadataStore {
  value: unknown;
  fail = false;
  load(): unknown { return this.value; }
  save(entries: readonly NotificationMetadata[]): void {
    if (this.fail) throw new Error("Disk unavailable");
    this.value = { version: 1, entries: entries.map((entry) => ({ ...entry, route: { ...entry.route } })) };
  }
}
type FakeHandle = { options: NativeOptions; callbacks: NativeCallbacks; closed: boolean; shown: boolean };
class FakeNative implements NotificationNativePort {
  available = true;
  throwOnShow = false;
  failOnShow = false;
  onClose: ((callbacks: NativeCallbacks) => void) | undefined;
  readonly handles: FakeHandle[] = [];
  readonly removed: string[] = [];
  activate: (osId: string) => void = () => {};
  coldId: string | undefined;
  historyIds: string[] = [];
  readonly historyCallbacks = new Map<string, NativeCallbacks>();
  supported(): boolean { return this.available; }
  create(options: NativeOptions, callbacks: NativeCallbacks) {
    const handle: FakeHandle = { options, callbacks, closed: false, shown: false };
    this.handles.push(handle);
    return {
      close: () => { handle.closed = true; this.onClose?.(callbacks); },
      show: () => {
        if (this.throwOnShow) throw new Error("Native failure");
        handle.shown = true;
        if (this.failOnShow) callbacks.failed();
      },
    };
  }
  subscribeActivation(activate: (osId: string) => void): () => void {
    this.activate = activate;
    if (this.coldId) activate(this.coldId);
    return () => { this.activate = () => {}; };
  }
  async restore(callbacks: (osId: string) => NativeCallbacks | undefined): Promise<void> {
    for (const id of this.historyIds) {
      const handlers = callbacks(id);
      if (handlers) this.historyCallbacks.set(id, handlers);
      else this.remove(id);
    }
  }
  remove(osId: string): void { this.removed.push(osId); }
  last(): FakeHandle {
    const last = this.handles.at(-1);
    assert.ok(last);
    return last;
  }
}
function request(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return { id: "event_1", accountId: "alice", kind: "message", route: { chatId: "chat_1" }, title: "Title", body: "Private content", silent: true, expiresAt: 1_000 + MESSAGE_TTL_MS, ...overrides };
}
async function fixture(store = new MemoryStore(), native = new FakeNative()) {
  let now = 1_000;
  const events: DesktopEvent[] = [];
  let focused = 0;
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const service = new NotificationService({ native, store, emit: (event) => events.push(event), onActivate: () => { focused++; }, now: () => now, schedule });
  await service.initialize();
  return { service, store, native, events, timers, focusCount: () => focused, setNow: (value: number) => { now = value; } };
}
function activationEvents(events: DesktopEvent[]): DesktopEvent[] {
  return events.filter((event) => event.type === "activation");
}

test("deduplicates events, replaces same chat group, bounds opaque Windows identifiers", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  assert.deepEqual(f.service.show(request()), { accepted: true });
  const first = f.native.last();
  assert.deepEqual(f.service.show(request()), { accepted: false, reason: "duplicate" });
  assert.deepEqual(f.service.show(request({ id: "event_2" })), { accepted: true });
  const second = f.native.last();
  assert.equal(first.closed, true);
  assert.match(second.options.osId, /^[a-f0-9]{16}$/);
  assert.match(second.options.groupId, /^[a-f0-9]{16}$/);
  assert.notEqual(first.options.osId, second.options.osId);
  assert.equal(first.options.groupId, second.options.groupId);
  f.service.setReady(true);
  first.callbacks.click();
  first.callbacks.failed();
  assert.equal(f.events.length, 0);
  second.callbacks.click();
  second.callbacks.click();
  f.native.activate(second.options.osId);
  assert.equal(activationEvents(f.events).length, 1);
});

test("queues activation once until ready and account match, but logout and old callback cannot navigate", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  f.service.show(request());
  const old = f.native.last();
  old.callbacks.click();
  assert.equal(f.focusCount(), 1);
  assert.equal(f.events.length, 0);
  f.service.setAccount(null);
  f.service.setReady(true);
  old.callbacks.click();
  f.native.activate(old.options.osId);
  f.service.setAccount("alice");
  f.service.show(request());
  const current = f.native.last();
  assert.notEqual(current.options.osId, old.options.osId);
  f.native.activate(old.options.osId);
  old.callbacks.failed();
  assert.equal(f.events.length, 0);
  current.callbacks.click();
  assert.equal(activationEvents(f.events).length, 1);
});

test("account switch clears pending events and all previous-account metadata", async () => {
  const f = await fixture();
  assert.deepEqual(f.service.show(request()), { accepted: false, reason: "account-mismatch" });
  f.service.setAccount("alice");
  f.service.show(request());
  const old = f.native.last();
  old.callbacks.click();
  f.service.setAccount("bob");
  f.service.setReady(true);
  assert.equal(old.closed, true);
  assert.deepEqual(validateJournal(f.store.value, 1_000), []);
  old.callbacks.click();
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.service.show(request()), { accepted: false, reason: "account-mismatch" });
  assert.throws(() => f.service.setAccount("../alice"), TypeError);
});

test("bounds calls at 60 seconds and messages at 24 hours; expired pending click is discarded", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  assert.deepEqual(f.service.show(request({ expiresAt: 1_000 })), { accepted: false, reason: "expired" });
  f.service.show(request({ kind: "call", route: { chatId: "chat_1", callId: "call_1" }, expiresAt: 999_999_999 }));
  const call = f.native.last();
  assert.equal(call.options.expiresAt, 1_000 + CALL_TTL_MS);
  call.callbacks.click();
  const timer = f.timers.filter((candidate) => !candidate.cancelled).at(-1);
  assert.ok(timer);
  assert.equal(timer.delay, CALL_TTL_MS);
  f.setNow(1_000 + CALL_TTL_MS);
  timer.callback();
  assert.equal(call.closed, true);
  f.service.setReady(true);
  assert.equal(f.events.length, 0);
  f.service.show(request({ expiresAt: 999_999_999 }));
  assert.equal(f.native.last().options.expiresAt, 1_000 + CALL_TTL_MS + MESSAGE_TTL_MS);
});

test("max100 active permits replacement but not new groups", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  for (let index = 0; index < MAX_NOTIFICATIONS; index++) {
    assert.equal(f.service.show(request({ id: `event_${index}`, route: { chatId: `chat_${index}` } })).accepted, true);
  }
  assert.deepEqual(f.service.show(request({ id: "overflow", route: { chatId: "new_chat" } })), { accepted: false, reason: "limit" });
  assert.equal(f.service.show(request({ id: "replacement", route: { chatId: "chat_0" } })).accepted, true);
  f.service.close({ id: "event_1", accountId: "bob" });
  assert.equal(validateJournal(f.store.value, 1_000).length, MAX_NOTIFICATIONS);
  f.service.close({ id: "event_1", accountId: "alice" });
  assert.equal(validateJournal(f.store.value, 1_000).length, MAX_NOTIFICATIONS - 1);
  f.service.clear();
  assert.equal(validateJournal(f.store.value, 1_000).length, 0);
});

test("cold central activation and restored history await trusted account binding and readiness", async () => {
  const original = await fixture();
  original.service.setAccount("alice");
  original.service.show(request());
  const osId = original.native.last().options.osId;
  original.service.dispose();
  const native = new FakeNative();
  native.coldId = osId;
  native.historyIds = [osId, "unknown"];
  const f = await fixture(original.store, native);
  assert.equal(f.focusCount(), 1);
  assert.equal(f.events.length, 0);
  assert.ok(native.historyCallbacks.has(osId));
  assert.deepEqual(native.removed, ["unknown"]);
  native.historyCallbacks.get(osId)?.click();
  f.service.setReady(true);
  assert.equal(f.events.length, 0);
  f.service.setAccount("alice");
  assert.equal(activationEvents(f.events).length, 1);
  assert.deepEqual(validateJournal(f.store.value, 1_000), []);
  native.activate(osId);
  assert.equal(activationEvents(f.events).length, 1);
});

test("restored account mismatch, logout and expired journal never emit activation", async () => {
  for (const account of [null, "bob"]) {
    const original = await fixture();
    original.service.setAccount("alice");
    original.service.show(request());
    const native = new FakeNative();
    native.coldId = original.native.last().options.osId;
    const f = await fixture(original.store, native);
    f.service.setAccount(account);
    f.service.setReady(true);
    assert.equal(f.events.length, 0);
  }
  const original = await fixture();
  original.service.setAccount("alice");
  original.service.show(request({ expiresAt: 1_001 }));
  assert.deepEqual(validateJournal(original.store.value, 1_001), []);
});

test("unsupported, synchronous/asynchronous native failure and journal failures are explicit", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  f.native.available = false;
  assert.deepEqual(f.service.show(request()), { accepted: false, reason: "unsupported" });
  f.native.available = true;
  f.native.throwOnShow = true;
  assert.deepEqual(f.service.show(request()), { accepted: false, reason: "failed" });
  f.native.throwOnShow = false;
  f.native.failOnShow = true;
  assert.deepEqual(f.service.show(request()), { accepted: false, reason: "failed" });
  f.native.failOnShow = false;
  f.service.show(request());
  f.native.last().callbacks.failed();
  assert.deepEqual(validateJournal(f.store.value, 1_000), []);
  f.store.fail = true;
  assert.deepEqual(f.service.show(request()), { accepted: false, reason: "failed" });
  assert.ok(f.events.every((event) => event.type === "notification-error"));
  f.service.dispose();
  assert.equal(f.service.supported(), false);
});

test("rejects invalid runtime schemas and untrusted journal fields/IDs/bounds", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  assert.throws(() => f.service.show(request({ id: "../event" })), TypeError);
  assert.throws(() => f.service.show(request({ route: { chatId: "https://bad" } })), TypeError);
  f.service.show(request());
  const entry = validateJournal(f.store.value, 1_000)[0];
  assert.ok(entry);
  const document = (entries: unknown[]) => ({ version: 1, entries });
  for (const value of [null, { version: 2, entries: [] }, { version: 1, entries: [], token: "secret" },
    document([{ ...entry, title: "private" }]), document([{ ...entry, accountId: "../alice" }]),
    document([{ ...entry, osId: "x".repeat(128) }]), document([{ ...entry, groupId: "unknown" }]),
    document([{ ...entry, expiresAt: 1_000 + MESSAGE_TTL_MS + 1 }]),
    document([{ ...entry, createdAt: 1_001 }]), document([entry, entry]),
    document(Array.from({ length: MAX_NOTIFICATIONS + 1 }, () => entry)),
  ]) assert.deepEqual(validateJournal(value, 1_000), []);
  assert.equal(JSON.stringify(f.store.value).includes("Private content"), false);
});

test("mixed expired/live journal preserves live messages and rejects duplicate account/event keys", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  f.service.show(request());
  f.service.show(request({ id: "call", kind: "call", route: { chatId: "chat_2", callId: "call_1" }, expiresAt: 1_001 }));
  assert.equal(validateJournal(f.store.value, 1_002).length, 1);
  const entry = validateJournal(f.store.value, 1_000)[0];
  assert.ok(entry);
  const other = { ...entry, osId: "fedcba9876543210", route: { chatId: "different" } };
  other.groupId = notificationGroupId(other);
  assert.deepEqual(validateJournal({ version: 1, entries: [entry, other] }, 1_000), []);
});

test("expiry on failed journal storage does not throw from a timer or allow late activation", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  f.service.show(request({ expiresAt: 1_001 }));
  const handle = f.native.last();
  f.store.fail = true;
  f.setNow(1_002);
  const timer = f.timers.filter((candidate) => !candidate.cancelled).at(-1);
  assert.ok(timer);
  assert.doesNotThrow(timer.callback);
  f.service.setReady(true);
  handle.callbacks.click();
  f.native.activate(handle.options.osId);
  assert.deepEqual(f.events, [{ type: "notification-error", id: "event_1", code: "failed" }]);
});

test("OS activation consumption handles storage failure without throwing or navigating", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  f.service.setReady(true);
  f.service.show(request());
  const handle = f.native.last();
  f.store.fail = true;
  assert.doesNotThrow(handle.callbacks.click);
  assert.equal(activationEvents(f.events).length, 0);
  assert.deepEqual(f.events, [{ type: "notification-error", id: "event_1", code: "failed" }]);
  f.native.activate(handle.options.osId);
  assert.equal(f.events.length, 1);
});

test("message dismissal uses persisted message-N IDs, safe cutoff and exact chat/kind/account", async () => {
  for (const [id, cutoff, removed] of [
    ["message-0", 0, true], ["message-0007", 7, true], ["message-7", 6, false],
    ["message-9007199254740991", Number.MAX_SAFE_INTEGER, true],
    ["message-9007199254740992", Number.MAX_SAFE_INTEGER, false],
    ["message-1x", 5, false], ["message--1", 5, false], ["event_1", 5, false],
    ["event_1", Number.MAX_SAFE_INTEGER, false], ["message-1x", Number.MAX_SAFE_INTEGER, false],
  ] as const) {
    const f = await fixture();
    f.service.setAccount("alice");
    f.service.show(request({ id }));
    const message = f.native.last();
    f.service.show(request({ id: "call", kind: "call", route: { chatId: "chat_1", callId: "call_1" } }));
    const call = f.native.last();
    f.service.show(request({ id: "test", kind: "test" }));
    const diagnostic = f.native.last();
    message.callbacks.click();
    f.service.dismiss({ accountId: "bob", kind: "message", chatId: "chat_1", throughMessageId: cutoff });
    f.service.dismiss({ accountId: "alice", kind: "message", chatId: "other", throughMessageId: cutoff });
    assert.equal(message.closed, false);
    f.service.dismiss({ accountId: "alice", kind: "message", chatId: "chat_1", throughMessageId: cutoff });
    assert.equal(message.closed, removed, id);
    assert.equal(call.closed, false);
    assert.equal(diagnostic.closed, false);
    assert.equal(validateJournal(f.store.value, 1_000).some((entry) => entry.id === id), !removed);
    f.service.setReady(true);
    message.callbacks.click(); message.callbacks.failed(); f.native.activate(message.options.osId);
    assert.equal(activationEvents(f.events).length, removed ? 0 : 1);
  }
});

test("scoped call dismissal invalidates pending click and late callbacks without closing replacement", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  f.service.show(request({ id: "message-5" }));
  const message = f.native.last();
  f.service.show(request({ id: "call-event", kind: "call", route: { chatId: "chat_1", callId: "call_1" } }));
  const old = f.native.last();
  old.callbacks.click();
  f.service.dismiss({ accountId: "bob", kind: "call", callId: "call_1" });
  f.service.dismiss({ accountId: "alice", kind: "call", callId: "other" });
  assert.equal(old.closed, false);
  f.native.onClose = (callbacks) => { queueMicrotask(() => { callbacks.click(); callbacks.failed(); }); };
  f.service.dismiss({ accountId: "alice", kind: "call", callId: "call_1" });
  assert.equal(old.closed, true);
  assert.equal(message.closed, false);
  f.service.show(request({ id: "call-event", kind: "call", route: { chatId: "chat_1", callId: "call_1" } }));
  const current = f.native.last();
  f.service.setReady(true);
  await Promise.resolve();
  old.callbacks.click(); old.callbacks.failed(); f.native.activate(old.options.osId);
  assert.equal(current.closed, false);
  assert.equal(activationEvents(f.events).length, 0);
  current.callbacks.click();
  assert.equal(activationEvents(f.events).length, 1);
});

test("restored journal scoped cleanup rejects late history callbacks and reconciles call exclusions", async () => {
  const original = await fixture();
  original.service.setAccount("alice");
  for (const value of [request({ id: "message-5" }),
    request({ id: "message-9", route: { chatId: "chat_2" } }),
    request({ id: "call-old", kind: "call", route: { chatId: "chat_1", callId: "old" } }),
    request({ id: "call-live", kind: "call", route: { chatId: "chat_1", callId: "live" } }),
  ]) original.service.show(value);
  const entries = validateJournal(original.store.value, 1_000);
  original.service.dispose();
  const native = new PendingHistoryNative();
  const events: DesktopEvent[] = [];
  const service = new NotificationService({ native, store: original.store, now: () => 1_000,
    emit: (event) => events.push(event), schedule: () => () => {} });
  const initialization = service.initialize();
  const callbacks = entries.map((entry) => native.historyLookup?.(entry.osId));
  callbacks[0]?.click(); callbacks[2]?.click();
  service.setAccount("alice");
  service.dismiss({ accountId: "bob", kind: "call", exceptCallIds: [] });
  assert.equal(validateJournal(original.store.value, 1_000).length, 4);
  service.dismiss({ accountId: "alice", kind: "message", chatId: "chat_1", throughMessageId: 5 });
  service.dismiss({ accountId: "alice", kind: "call", exceptCallIds: ["live"] });
  assert.deepEqual(validateJournal(original.store.value, 1_000).map((entry) => entry.id), ["message-9", "call-live"]);
  for (const index of [0, 2]) {
    const entry = entries[index]; assert.ok(entry);
    assert.equal(native.historyLookup?.(entry.osId), undefined);
    callbacks[index]?.click(); callbacks[index]?.failed(); native.activate(entry.osId);
  }
  service.setReady(true);
  assert.equal(activationEvents(events).length, 0);
  service.dismiss({ accountId: "alice", kind: "call", exceptCallIds: [] });
  assert.deepEqual(validateJournal(original.store.value, 1_000).map((entry) => entry.id), ["message-9"]);
  native.finishRestore(); await initialization;
  service.dispose();
});

test("scoped dismissal validates runtime input and preserves in-memory cancellation on storage failure", async () => {
  const f = await fixture();
  f.service.setAccount("alice");
  f.service.show(request({ id: "message-5" }));
  const handle = f.native.last();
  handle.callbacks.click();
  assert.throws(() => f.service.dismiss({ accountId: "alice", kind: "message", chatId: "chat_1", throughMessageId: -1 }), TypeError);
  assert.equal(handle.closed, false);
  f.store.fail = true;
  assert.throws(() => f.service.dismiss({ accountId: "alice", kind: "message", chatId: "chat_1", throughMessageId: 5 }));
  f.service.setReady(true);
  handle.callbacks.click(); handle.callbacks.failed(); f.native.activate(handle.options.osId);
  assert.equal(activationEvents(f.events).length, 0);
});

class PendingHistoryNative extends FakeNative {
  historyLookup: ((osId: string) => NativeCallbacks | undefined) | undefined;
  finishRestore: () => void = () => {};
  override restore(callbacks: (osId: string) => NativeCallbacks | undefined): Promise<void> {
    this.historyLookup = callbacks;
    return new Promise((resolve) => { this.finishRestore = resolve; });
  }
}

test("pending native history does not block show/readiness or the restored entry expiry timer", async () => {
  const original = await fixture();
  original.service.setAccount("alice");
  original.service.show(request({ expiresAt: 1_001 }));
  const osId = original.native.last().options.osId;
  original.service.dispose();
  const native = new PendingHistoryNative();
  let now = 1_000;
  const events: DesktopEvent[] = [];
  const timers: { callback: () => void; cancelled: boolean }[] = [];
  const service = new NotificationService({ native, store: original.store, now: () => now,
    emit: (event) => events.push(event), schedule: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    } });
  const initialization = service.initialize();
  assert.equal(timers.length, 1);
  assert.ok(native.historyLookup?.(osId));
  service.setAccount("alice");
  service.setReady(true);
  assert.equal(service.show(request({ id: "while_pending", route: { chatId: "chat_2" } })).accepted, true);
  native.last().callbacks.click();
  assert.equal(activationEvents(events).length, 1);
  now = 1_002;
  const timer = timers.filter((candidate) => !candidate.cancelled).at(-1);
  assert.ok(timer);
  timer.callback();
  assert.ok(native.removed.includes(osId));
  assert.equal(native.historyLookup?.(osId), undefined);
  native.finishRestore();
  await initialization;
  service.dispose();
});

test("late history lookup rejects logout, account switch and disposal", async () => {
  for (const action of ["logout", "switch", "dispose"]) {
    const original = await fixture();
    original.service.setAccount("alice");
    original.service.show(request());
    const osId = original.native.last().options.osId;
    original.service.dispose();
    const native = new PendingHistoryNative();
    const events: DesktopEvent[] = [];
    const service = new NotificationService({ native, store: original.store, now: () => 1_000,
      emit: (event) => events.push(event), schedule: () => () => {} });
    const initialization = service.initialize();
    const stale = native.historyLookup?.(osId);
    assert.ok(stale);
    service.setAccount("alice");
    if (action === "dispose") service.dispose();
    else service.setAccount(action === "logout" ? null : "bob");
    service.setReady(true);
    assert.equal(native.historyLookup?.(osId), undefined);
    stale.click();
    assert.equal(activationEvents(events).length, 0);
    native.finishRestore();
    await initialization;
    service.dispose();
  }
});

class FakeElectronNotification {
  static instances: FakeElectronNotification[] = [];
  static delivered: FakeElectronNotification[] = [];
  static historyPromise: Promise<FakeElectronNotification[]> | undefined;
  static removed: string[] = [];
  static calls: string[] = [];
  static activation: (details: unknown) => void = () => {};
  readonly id: string;
  readonly listeners = new Map<string, () => void>();
  closed = false;
  shows = 0;
  constructor(readonly options: NotificationConstructorOptions) {
    this.id = options.id ?? "";
    FakeElectronNotification.instances.push(this);
  }
  static isSupported(): boolean { this.calls.push("isSupported"); return true; }
  static handleActivation(callback: (details: unknown) => void): void { this.activation = callback; }
  static async getHistory(): Promise<FakeElectronNotification[]> { this.calls.push("getHistory"); return this.historyPromise ?? this.delivered; }
  static remove(id: string): void { this.calls.push("remove"); this.removed.push(id); }
  on(event: "click" | "failed", callback: () => void): void { this.listeners.set(event, callback); }
  show(): void { this.shows++; }
  close(): void { this.closed = true; }
}

test("macOS presenter APIs are gated until granted, including cleanup and deferred cold restore", async () => {
  const store = new MemoryStore();
  const original = await fixture(store); original.service.setAccount("alice"); original.service.show(request());
  const id = original.native.last().options.osId; original.service.dispose();
  const restored = new FakeElectronNotification({ id });
  FakeElectronNotification.delivered = [restored]; FakeElectronNotification.calls = [];
  let granted = false;
  const events: DesktopEvent[] = [];
  const port = createElectronNotificationPort("darwin", FakeElectronNotification, () => granted);
  const service = new NotificationService({ native: port, store, now: () => 1_000,
    emit: (event) => events.push(event), schedule: () => () => {} });
  await service.initialize();
  assert.equal(service.supported(), true);
  service.setAccount("alice"); service.setReady(true);
  assert.equal(service.show(request({ id: "blocked", route: { chatId: "other" } })).accepted, false);
  port.remove?.("expired");
  assert.deepEqual(FakeElectronNotification.calls, []);
  assert.equal(validateJournal(store.value, 1_000).length, 1);
  granted = true;
  await service.restoreNative();
  restored.listeners.get("click")?.();
  assert.equal(activationEvents(events).length, 1);
  granted = false; FakeElectronNotification.calls = [];
  service.clear(); assert.equal(service.show(request()).accepted, false);
  assert.deepEqual(FakeElectronNotification.calls, []);
  service.dispose();
});

test("Electron adapter converges warm instance and central Windows callbacks in both orderings", async () => {
  for (const centralFirst of [true, false]) {
    const events: DesktopEvent[] = [];
    const port = createElectronNotificationPort("win32", FakeElectronNotification);
    const service = new NotificationService({ native: port, emit: (event) => events.push(event), now: () => 1_000, schedule: () => () => {} });
    await service.initialize();
    service.setAccount("alice");
    service.setReady(true);
    service.show(request());
    const notification = FakeElectronNotification.instances.at(-1);
    assert.ok(notification);
    assert.ok(notification.options.toastXml?.includes(`launch="type=click&amp;tag=${notification.id}"`));
    const central = () => FakeElectronNotification.activation({ type: "click", arguments: `type=click&tag=${notification.id}` });
    const instance = () => notification.listeners.get("click")?.();
    if (centralFirst) { central(); instance(); } else { instance(); central(); }
    assert.equal(activationEvents(events).length, 1);
    assert.equal(notification.closed, true);
    service.dispose();
    central();
    assert.equal(activationEvents(events).length, 1);
  }
});

test("Electron macOS history reattaches click without re-show and removes unknown IDs", async () => {
  const store = new MemoryStore();
  const original = await fixture(store);
  original.service.setAccount("alice");
  original.service.show(request());
  const id = original.native.last().options.osId;
  const restored = new FakeElectronNotification({ id });
  const unknown = new FakeElectronNotification({ id: "unknown" });
  FakeElectronNotification.delivered = [restored, unknown];
  FakeElectronNotification.removed = [];
  const events: DesktopEvent[] = [];
  const service = new NotificationService({ native: createElectronNotificationPort("darwin", FakeElectronNotification, () => true), store,
    emit: (event) => events.push(event), now: () => 1_000, schedule: () => () => {} });
  await service.initialize();
  service.setAccount("alice");
  service.setReady(true);
  assert.equal(restored.shows, 0);
  assert.deepEqual(FakeElectronNotification.removed, ["unknown"]);
  restored.listeners.get("click")?.();
  assert.equal(activationEvents(events).length, 1);
  assert.ok(FakeElectronNotification.removed.includes(id));
  service.dispose();
});

test("late macOS history after Quit neither binds nor removes delivered notifications", async () => {
  const restored = new FakeElectronNotification({ id: "0123456789abcdef" });
  let finishHistory: (items: FakeElectronNotification[]) => void = () => {};
  FakeElectronNotification.historyPromise = new Promise((resolve) => { finishHistory = resolve; });
  FakeElectronNotification.removed = [];
  try {
    const service = new NotificationService({ native: createElectronNotificationPort("darwin", FakeElectronNotification, () => true),
      emit: () => {}, schedule: () => () => {} });
    const initialization = service.initialize();
    service.dispose();
    finishHistory([restored]);
    await initialization;
    assert.equal(restored.listeners.size, 0);
    assert.deepEqual(FakeElectronNotification.removed, []);
  } finally { FakeElectronNotification.historyPromise = undefined; }
});

test("Windows arguments require exact pinned schema, and XML treats text only as text", () => {
  const id = "0123456789abcdef";
  assert.equal(parseWindowsActivation({ type: "click", arguments: `type=click&tag=${id}` }), id);
  for (const value of [undefined, { type: "action", arguments: `type=click&tag=${id}` },
    { type: "click", arguments: id }, { type: "click", arguments: `tag=${id}&type=click` },
    { type: "click", arguments: `type=click&tag=${id}&tag=${id}` },
    { type: "click", arguments: `type=click&tag=${id}&url=https://bad` },
    { type: "click", arguments: JSON.stringify({ route: "bad" }) },
  ]) assert.equal(parseWindowsActivation(value), undefined);
  const options = { ...request({ title: '<tag "quoted">&', body: "</text><script>bad</script>\u0000" }), osId: id, groupId: notificationGroupId(request()) };
  const xml = windowsToastXml(options);
  assert.ok(xml.includes(`launch="type=click&amp;tag=${id}"`));
  assert.ok(xml.includes("&lt;tag &quot;quoted&quot;&gt;&amp;"));
  assert.ok(xml.includes("&lt;/text&gt;&lt;script&gt;"));
  assert.ok(xml.includes('<audio silent="true"/>'));
  assert.equal(xml.includes("\u0000"), false);
  assert.throws(() => windowsToastXml({ ...options, osId: 'bad"' }), TypeError);
});
