import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import * as contract from "./contract";
import * as lifecycle from "./lifecycle";
import * as notifications from "./notifications";
import * as security from "./security";
import type { DesktopEvent, WindowState } from "./contract";
import type { NativeCallbacks, NotificationMetadata, NotificationNativePort } from "./notifications";

const origin = "https://chat.example";
const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/main.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);
const source = compiled.stdout;

async function fixture(cold = false) {
  const events: DesktopEvent[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const power = new EventEmitter();
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setPath() {}, setAppUserModelId() {}, enableSandbox() {},
    getPath: () => "/unused-test-profile", requestSingleInstanceLock: () => true,
    whenReady: async () => {}, setBadgeCount: () => true, quit() {}, exit() {},
  });
  let state: WindowState = { focused: false, visible: false, minimized: true };
  const frame = { origin, url: `${origin}/`, parent: null, isDestroyed: () => false,
    send: (_channel: string, event: DesktopEvent) => { events.push(structuredClone(event)); } };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => false, setWindowOpenHandler() {}, getURL: () => `${origin}/`,
  });
  class Window extends EventEmitter {
    webContents = contents;
    isDestroyed() { return false; }
    isFocused() { return state.focused; }
    isVisible() { return state.visible; }
    isMinimized() { return state.minimized; }
    restore() { state = { ...state, minimized: false }; }
    show() { state = { ...state, visible: true }; }
    focus() { state = { ...state, focused: true }; }
    async loadURL() {}
  }
  const ses = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {}, protocol: { handle() {} },
  });
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
  const seed = { id: "message-5", accountId: "alice", kind: "message", route: { chatId: "chat_1" },
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, osId: "0123456789abcdef" };
  const metadata = { ...seed, groupId: notifications.notificationGroupId({ accountId: "alice", kind: "message", route: seed.route }) };
  let journal: unknown = { version: 1, entries: cold ? [metadata] : [] };
  class Store {
    load(): unknown { return journal; }
    save(entries: readonly NotificationMetadata[]) { journal = { version: 1, entries }; }
  }
  let callbacks: NativeCallbacks | undefined;
  const native: NotificationNativePort = {
    supported: () => true,
    create: (_options, value) => { callbacks = value; return { show() {}, close() {} }; },
    subscribeActivation: (activate) => { if (cold) activate(seed.osId); return () => {}; },
  };
  const modules: Record<string, unknown> = {
    electron: {
      app, BrowserWindow: Window, ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
      Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu() {} },
      nativeImage: { createFromBitmap: () => ({ setTemplateImage() {} }) },
      powerMonitor: power, protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => ses },
      shell: {}, dialog: { showErrorBox: () => { throw new Error("Unexpected startup failure"); } }, Tray,
    },
    "node:fs": { existsSync: () => false }, "node:path": { join: (...parts: string[]) => parts.join("/") },
    "./contract": contract, "./security": security, "./lifecycle": lifecycle, "./notifications": notifications,
    "./config": { resolveConfiguration: () => ({ spike: true, trustedOrigin: origin, appURL: `${origin}/`, partition: "test", profileKey: "test" }) },
    "./electron-notifications": { createElectronNotificationPort: () => native },
    "./notification-store": { FileMetadataStore: Store }, "./desktop-auth": {}, "./electron-auth": {},
  };
  runInNewContext(source, {
    require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; },
    __dirname: "/unused-test-bundle", process: { platform: "darwin", argv: [], env: {} },
    console: { info() {}, error() {} }, Buffer, setImmediate, setTimeout, clearTimeout,
  });
  await new Promise<void>((done) => setImmediate(done));
  assert.ok(handlers.has(contract.IPC.ready));
  const sender = { sender: contents, senderFrame: frame };
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel); assert.ok(handler, `Missing handler ${channel}`);
    return handler(sender, ...args);
  };
  return { events, handlers, sender, invoke, power, stop: () => app.emit("before-quit"),
    setState: (value: WindowState) => { state = value; },
    click: () => { assert.ok(callbacks); callbacks.click(); },
  };
}

function show(f: Awaited<ReturnType<typeof fixture>>) {
  f.invoke(contract.IPC.setAccount, "alice");
  assert.deepEqual(f.invoke(contract.IPC.showNotification, {
    id: "message-5", accountId: "alice", kind: "message", title: "Title", body: "Body",
    route: { chatId: "chat_1" }, silent: true, expiresAt: Date.now() + 60_000,
  }), { accepted: true });
}

test("ready publishes initial native state before flushing a queued activation", async () => {
  const f = await fixture();
  try {
    show(f); f.click();
    const current = { focused: true, visible: true, minimized: false };
    f.setState(current);
    f.invoke(contract.IPC.ready);
    assert.deepEqual(f.events.map((event) => event.type), ["window-state", "activation"]);
    assert.deepEqual(f.events[0], { type: "window-state", state: current });
  } finally { f.stop(); }
});

test("already-ready setAccount publishes current state before a cold pending activation", async () => {
  const f = await fixture(true);
  try {
    f.invoke(contract.IPC.ready);
    f.events.length = 0;
    const current = { focused: false, visible: true, minimized: false };
    f.setState(current);
    f.invoke(contract.IPC.setAccount, "alice");
    assert.deepEqual(f.events.map((event) => event.type), ["window-state", "activation"]);
    assert.deepEqual(f.events[0], { type: "window-state", state: current });
  } finally { f.stop(); }
});

test("resume refreshes native state before resume event and never sends lifecycle before ready", async () => {
  const f = await fixture();
  try {
    f.power.emit("resume");
    assert.deepEqual(f.events, []);
    f.invoke(contract.IPC.ready);
    f.events.length = 0;
    const current = { focused: false, visible: false, minimized: true };
    f.setState(current); f.power.emit("resume");
    assert.deepEqual(f.events, [{ type: "window-state", state: current }, { type: "resume" }]);
  } finally { f.stop(); }
});

test("dismiss IPC validates arity, selector and trusted sender without extending capabilities", async () => {
  const f = await fixture();
  try {
    show(f); f.click();
    const selector = { accountId: "alice", kind: "message", chatId: "chat_1", throughMessageId: 5 };
    f.invoke(contract.IPC.dismissNotifications, selector);
    f.invoke(contract.IPC.ready);
    assert.equal(f.events.some((event) => event.type === "activation"), false);
    assert.throws(() => f.invoke(contract.IPC.dismissNotifications, { ...selector, extra: true }));
    assert.throws(() => f.invoke(contract.IPC.dismissNotifications));
    assert.throws(() => f.invoke(contract.IPC.dismissNotifications, selector, selector));
    const handler = f.handlers.get(contract.IPC.dismissNotifications); assert.ok(handler);
    assert.throws(() => handler({ ...f.sender, senderFrame: { ...f.sender.senderFrame, origin: "https://attacker.example" } }, selector));
    assert.throws(() => handler({ ...f.sender, senderFrame: { ...f.sender.senderFrame, parent: f.sender.senderFrame } }, selector));
    const capabilities = f.invoke(contract.IPC.capabilities);
    assert.ok(contract.isRecord(capabilities));
    assert.deepEqual(Object.keys(capabilities).sort(), ["version", "platform", "notifications", "notificationPermission", "badge", "lifecycle", "productionAuth"].sort());
  } finally { f.stop(); }
});
