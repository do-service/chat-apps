import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import * as contract from "./contract";
import * as lifecycle from "./lifecycle";
import * as mediaPermissions from "./media-permissions";
import * as notifications from "./notifications";
import * as notificationPermissions from "./notification-permission";
import * as security from "./security";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopEvent, WindowState } from "./contract";
import type { NativeCallbacks, NotificationMetadata, NotificationNativePort } from "./notifications";

const origin = "https://chat.example";
const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/main.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);
const source = compiled.stdout;

type MediaStatus = ReturnType<Electron.SystemPreferences["getMediaAccessStatus"]>;
type MediaKind = "microphone" | "camera";
type PermissionDetails = Record<string, unknown>;
type RequestHandler = (contents: unknown, permission: string, callback: (allowed: boolean) => void, details: PermissionDetails) => void;
type CheckHandler = (contents: unknown, permission: string, requestingOrigin: string, details: PermissionDetails) => boolean;

async function fixture(cold = false, options: { spike?: boolean; platform?: string; status?: MediaStatus; cameraStatus?: MediaStatus; notificationPermission?: string; realNotificationPermission?: boolean } = {}) {
  const events: DesktopEvent[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const power = new EventEmitter();
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setPath() {}, setAppUserModelId() {}, enableSandbox() {},
    getPath: () => "/unused-test-profile", requestSingleInstanceLock: () => true,
    whenReady: async () => {}, setBadgeCount: () => true, quit() {}, exit() {},
  });
  let state: WindowState = { focused: false, visible: false, minimized: true };
  let destroyed = false;
  let contentsDestroyed = false;
  let frameDestroyed = false;
  let frameParent: unknown = null;
  let contentsURL: string | undefined;
  const mediaStatus: Record<MediaKind, MediaStatus> = {
    microphone: options.status ?? "granted", camera: options.cameraStatus ?? "granted",
  };
  const osCalls: string[] = [];
  let notificationPermission = options.notificationPermission ?? "granted";
  const notificationCalls: string[] = [];
  let notificationQuery = async () => notificationPermission;
  let notificationRequest = async () => { notificationPermission = "granted"; return notificationPermission; };
  const permission = {
    current: () => notificationPermission,
    get: async (current = () => true) => { notificationCalls.push("get"); const result = await notificationQuery(); return current() ? result : "unknown"; },
    request: async (current = () => true, canPrompt = current) => {
      const status = await permission.get(current);
      if (!current() || !canPrompt()) return "unknown";
      if (status !== "not-determined") return status;
      notificationCalls.push("request"); const result = await notificationRequest(); return current() ? result : "unknown";
    },
  };
  const consent: Record<MediaKind, () => Promise<boolean>> = {
    microphone: async () => { mediaStatus.microphone = "granted"; return true; },
    camera: async () => { mediaStatus.camera = "granted"; return true; },
  };
  const statusFailures = new Set<MediaKind>();
  let requestHandler: RequestHandler | undefined;
  let checkHandler: CheckHandler | undefined;
  let deviceHandler: (() => boolean) | undefined;
  let displayHandler: ((request: unknown, callback: (value: unknown) => void) => void) | undefined;
  const messages: { message: string }[] = [];
  const applicationMenus: MenuItemConstructorOptions[][] = [];
  const trayMenus: MenuItemConstructorOptions[][] = [];
  const frame = { origin, url: `${origin}/`, get parent() { return frameParent; }, isDestroyed: () => frameDestroyed,
    send: (_channel: string, event: DesktopEvent) => { events.push(structuredClone(event)); } };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => contentsDestroyed, setWindowOpenHandler() {}, getURL: () => contentsURL ?? frame.url,
  });
  class Window extends EventEmitter {
    webContents = contents;
    isDestroyed() { return destroyed; }
    isFocused() { return state.focused; }
    isVisible() { return state.visible; }
    isMinimized() { return state.minimized; }
    restore() { state = { ...state, minimized: false }; }
    show() { state = { ...state, visible: true }; }
    focus() { state = { ...state, focused: true }; this.emit("focus"); }
    async loadURL() {}
  }
  const ses = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler(handler: RequestHandler) { requestHandler = handler; },
    setPermissionCheckHandler(handler: CheckHandler) { checkHandler = handler; },
    setDevicePermissionHandler(handler: () => boolean) { deviceHandler = handler; },
    setDisplayMediaRequestHandler(handler: typeof displayHandler) { displayHandler = handler; }, protocol: { handle() {} },
  });
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(menu: { items: MenuItemConstructorOptions[] }) { trayMenus.push(menu.items); }
    destroy() {}
  }
  const seed = { id: "message-5", accountId: "alice", kind: "message", route: { chatId: "chat_1" },
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, osId: "0123456789abcdef" };
  const metadata = { ...seed, groupId: notifications.notificationGroupId({ accountId: "alice", kind: "message", route: seed.route }) };
  let journal: unknown = { version: 1, entries: cold ? [metadata] : [] };
  class Store {
    load(): unknown { return journal; }
    save(entries: readonly NotificationMetadata[]) { journal = { version: 1, entries }; }
  }
  let callbacks: NativeCallbacks | undefined;
  const createdNotifications: string[] = [];
  const native: NotificationNativePort = {
    supported: () => true,
    create: (options, value) => { createdNotifications.push(options.id); callbacks = value; return { show() {}, close() {} }; },
    subscribeActivation: (activate) => { if (cold) activate(seed.osId); return () => {}; },
  };
  const modules: Record<string, unknown> = {
    electron: {
      app, BrowserWindow: Window, ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
      Menu: {
        buildFromTemplate: (items: MenuItemConstructorOptions[]) => ({ items }),
        setApplicationMenu: (menu: { items: MenuItemConstructorOptions[] }) => { applicationMenus.push(menu.items); },
      },
      systemPreferences: {
        getMediaAccessStatus: (kind: MediaKind) => { osCalls.push(`status:${kind}`); if (statusFailures.has(kind)) throw new Error("secret URL"); return mediaStatus[kind]; },
        askForMediaAccess: (kind: MediaKind) => { osCalls.push(`ask:${kind}`); return consent[kind](); },
      },
      nativeImage: { createFromBitmap: () => ({ setTemplateImage() {} }) },
      powerMonitor: power, protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => ses },
      shell: { openExternal: async (url: string) => { notificationCalls.push(url); } }, dialog: {
        showErrorBox: () => { throw new Error("Unexpected startup failure"); },
        showMessageBox: async (value: { message: string }) => { messages.push(value); return { response: 0 }; },
      }, Tray,
    },
    "node:fs": { existsSync: () => false }, "node:path": { join: (...parts: string[]) => parts.join("/") },
    "./contract": contract, "./security": security, "./lifecycle": lifecycle, "./media-permissions": mediaPermissions, "./notifications": notifications,
    "./config": { resolveConfiguration: () => ({ spike: options.spike ?? true, trustedOrigin: origin, appURL: `${origin}/`, partition: "test", profileKey: "test" }) },
    "./electron-notifications": { createElectronNotificationPort: () => native },
    "./notification-permission": {
      ...notificationPermissions,
      createNotificationPermissionController: () => options.realNotificationPermission
        ? notificationPermissions.createNotificationPermissionController("darwin", () => ({
          getPermission: () => { notificationCalls.push("get"); return notificationQuery(); },
          requestPermission: () => { notificationCalls.push("request"); return notificationRequest(); },
        })) : permission,
    },
    "./notification-store": { FileMetadataStore: Store },
    "./desktop-auth": { DesktopAuthService: class { dispose() {} } },
    "./electron-auth": { installAuthCookieBarrier: () => ({}) },
  };
  runInNewContext(source, {
    require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; },
    __dirname: "/unused-test-bundle", process: { platform: options.platform ?? "darwin", argv: [], env: {} },
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
    contents, frame, osCalls, notificationCalls, applicationMenus, trayMenus, createdNotifications,
    activate: () => app.emit("activate"),
    setNotificationPermission: (value: string) => { notificationPermission = value; },
    setNotificationQuery: (value: () => Promise<string>) => { notificationQuery = value; },
    setNotificationRequest: (value: () => Promise<string>) => { notificationRequest = value; },
    setMediaStatus: (value: MediaStatus, kind: MediaKind = "microphone") => { mediaStatus[kind] = value; },
    setConsent: (value: () => Promise<boolean>, kind: MediaKind = "microphone") => { consent[kind] = value; },
    failStatus: (kind: MediaKind = "microphone") => { statusFailures.add(kind); },
    destroyWindow: () => { destroyed = true; },
    destroyContents: () => { contentsDestroyed = true; },
    destroyFrame: () => { frameDestroyed = true; },
    setFrameParent: (value: unknown) => { frameParent = value; },
    setContentsURL: (value: string) => { contentsURL = value; },
    navigate: (url = frame.url) => {
      contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      frame.url = url;
    },
    request: (details: PermissionDetails, permission = "media", senderContents: unknown = contents) => {
      assert.ok(requestHandler);
      const answers: boolean[] = [];
      requestHandler(senderContents, permission, (allowed) => answers.push(allowed), details);
      return answers;
    },
    check: (details: PermissionDetails, permission = "media", senderContents: unknown = contents, requestingOrigin = origin) => {
      assert.ok(checkHandler); return checkHandler(senderContents, permission, requestingOrigin, details);
    },
    device: () => { assert.ok(deviceHandler); return deviceHandler(); },
    display: () => {
      assert.ok(displayHandler); const answers: unknown[] = [];
      displayHandler({}, (value) => answers.push(value)); return answers;
    },
    diagnostic: async () => {
      const menu = trayMenus[0]?.find((item) => item.label === "Диагностика фокуса и ограничений"); assert.ok(menu?.click);
      Reflect.apply(menu.click, undefined, []); await new Promise<void>((done) => setImmediate(done)); return messages.at(-1)?.message;
    },
  };
}

async function show(f: Awaited<ReturnType<typeof fixture>>) {
  f.invoke(contract.IPC.setAccount, "alice");
  assert.deepEqual(await f.invoke(contract.IPC.showNotification, {
    id: "message-5", accountId: "alice", kind: "message", title: "Title", body: "Body",
    route: { chatId: "chat_1" }, silent: true, expiresAt: Date.now() + 60_000,
  }), { accepted: true });
}

for (const [role, accelerator] of [["minimize", "Command+M"], ["hide", "Command+H"]]) {
  test(`macOS application menu registers native ${role} with ${accelerator} exactly once`, async () => {
    const f = await fixture(false, { platform: "darwin" });
    try {
      assert.equal(f.applicationMenus.length, 1);
      const menu = f.applicationMenus[0]; assert.ok(menu);
      const items = menu.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : []);
      const matches = items.filter((item) => item.role === role);
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.accelerator, accelerator);
      assert.equal(matches[0]?.click, undefined);
      assert.equal(items.filter((item) => item.accelerator === accelerator).length, 1);
      const parent = menu.find((item) => Array.isArray(item.submenu) && item.submenu.includes(matches[0]));
      assert.equal(parent?.label, role === "hide" ? "Chat Desktop Spike" : "Окно");
    } finally { f.stop(); }
  });
}

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} application menu preserves edit, close and quit actions without adding native roles to tray`, async () => {
    const f = await fixture(false, { platform });
    try {
      assert.equal(f.applicationMenus.length, 1); assert.equal(f.trayMenus.length, 1);
      const menu = f.applicationMenus[0]; assert.ok(menu);
      const edit = menu.find((item) => item.label === "Правка"); assert.ok(Array.isArray(edit?.submenu));
      assert.deepEqual(Array.from(edit.submenu, (item) => item.role ?? item.type), ["undo", "redo", "separator", "cut", "copy", "paste", "selectAll"]);
      const application = menu.find((item) => item.label === "Chat Desktop Spike"); assert.ok(Array.isArray(application?.submenu));
      const tray = f.trayMenus[0]; assert.ok(tray);
      assert.deepEqual(Array.from(tray, (item) => item.label ?? item.type), [
        "Открыть", "Скрыть окно", "Повторить загрузку", "Диагностика фокуса и ограничений",
        "Тестовое уведомление (--spike)", "Очистить уведомления", "separator", "Выход",
      ]);
      assert.equal(tray.some((item) => item.role === "hide" || item.role === "minimize"), false);
      for (const [label, accelerator] of [["Скрыть окно", "CommandOrControl+W"], ["Выход", "CommandOrControl+Q"]]) {
        const action: MenuItemConstructorOptions | undefined = application.submenu.find((item) => item.label === label); assert.ok(action?.click);
        assert.equal(action.accelerator, accelerator);
        assert.equal(tray.find((item) => item.label === label)?.click, action.click);
      }
      const items = menu.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : []);
      const accelerators = items.flatMap((item) => item.accelerator ? [item.accelerator] : []);
      assert.equal(new Set(accelerators).size, accelerators.length);
      if (platform !== "darwin") {
        assert.deepEqual(Array.from(menu, (item) => item.label), ["Chat Desktop Spike", "Правка"]);
        assert.equal(items.some((item) => item.role === "hide" || item.role === "minimize"), false);
        assert.equal(accelerators.some((value) => /\+(?:M|H)$/u.test(value)), false);
      }
    } finally { f.stop(); }
  });
}

for (const overlap of ["show", "get", "focus"]) {
  test(`real main permission keeps granted notification during concurrent ${overlap}`, async () => {
    const f = await fixture(false, { realNotificationPermission: true });
    try {
      f.invoke(contract.IPC.setAccount, "alice");
      const request = (id: string) => ({ id, accountId: "alice", kind: "message", title: "Title", body: "Body",
        route: { chatId: id }, silent: true, expiresAt: Date.now() + 60_000 });
      const first = f.invoke(contract.IPC.showNotification, request("message-1"));
      const second = overlap === "show" ? f.invoke(contract.IPC.showNotification, request("message-2"))
        : overlap === "get" ? f.invoke(contract.IPC.getNotificationPermission) : f.activate();
      assert.deepEqual(await first, { accepted: true });
      if (overlap === "show") assert.deepEqual(await second, { accepted: true });
      if (overlap === "get") assert.equal(await second, "granted");
      assert.deepEqual(f.createdNotifications, overlap === "show" ? ["message-1", "message-2"] : ["message-1"]);
      assert.equal(f.notificationCalls.includes("request"), false);
    } finally { f.stop(); }
  });
}

for (const change of ["navigate", "logout", "quit"]) {
  test(`real main shared permission read rejects both stale notifications after ${change}`, async () => {
    const f = await fixture(false, { realNotificationPermission: true });
    try {
      f.invoke(contract.IPC.setAccount, "alice");
      let resolve: ((value: string) => void) | undefined;
      f.setNotificationQuery(() => new Promise<string>((done) => { resolve = done; }));
      const request = (id: string) => ({ id, accountId: "alice", kind: "message", title: "Title", body: "Body",
        route: { chatId: id }, silent: true, expiresAt: Date.now() + 60_000 });
      const first = f.invoke(contract.IPC.showNotification, request("message-1"));
      const second = f.invoke(contract.IPC.showNotification, request("message-2"));
      await settle(); assert.ok(resolve);
      if (change === "navigate") f.navigate();
      if (change === "logout") f.invoke(contract.IPC.setAccount, null);
      if (change === "quit") f.stop();
      resolve("granted");
      for (const pending of [first, second]) assert.deepEqual(structuredClone(await pending), { accepted: false, reason: "failed" });
      assert.deepEqual(f.createdNotifications, []);
    } finally { f.stop(); }
  });
}

for (const change of ["none", "blur", "navigate", "logout", "quit"]) {
  test(`real main explicit permission transaction withstands passive get, focus and show with ${change}`, async () => {
    const f = await fixture(false, { realNotificationPermission: true, notificationPermission: "not-determined" });
    try {
      f.invoke(contract.IPC.setAccount, "alice"); f.invoke(contract.IPC.ready);
      f.setState({ focused: true, visible: true, minimized: false });
      let resolve: ((value: string) => void) | undefined;
      f.setNotificationRequest(() => new Promise<string>((done) => { resolve = done; }));
      const consent = f.invoke(contract.IPC.requestNotificationPermission); await settle(); assert.ok(resolve);
      const reads = f.notificationCalls.filter((call) => call === "get").length;
      const passive = f.invoke(contract.IPC.getNotificationPermission);
      const show = f.invoke(contract.IPC.showNotification, {
        id: "message-1", accountId: "alice", kind: "message", title: "Title", body: "Body",
        route: { chatId: "chat-1" }, silent: true, expiresAt: Date.now() + 60_000,
      });
      f.activate(); await settle();
      assert.equal(f.notificationCalls.filter((call) => call === "get").length, reads);
      if (change === "blur") f.setState({ focused: false, visible: true, minimized: false });
      if (change === "navigate") f.navigate();
      if (change === "logout") f.invoke(contract.IPC.setAccount, null);
      if (change === "quit") f.stop();
      f.setNotificationPermission("granted"); resolve("granted");
      const valid = change === "none" || change === "blur";
      assert.equal(await consent, valid ? "granted" : "unknown");
      assert.equal(await passive, valid ? "granted" : "unknown");
      assert.deepEqual(structuredClone(await show), valid ? { accepted: true } : { accepted: false, reason: "failed" });
      assert.deepEqual(f.createdNotifications, valid ? ["message-1"] : []);
      assert.equal(f.notificationCalls.filter((call) => call === "request").length, 1);
    } finally { f.stop(); }
  });
}

test("main notification permission is passive at startup and explicit enable requests once", async () => {
  const f = await fixture(false, { spike: false, notificationPermission: "not-determined" });
  try {
    assert.equal(f.notificationCalls.includes("request"), false);
    const get = "chat-desktop:v1:get-notification-permission";
    const request = "chat-desktop:v1:request-notification-permission";
    assert.equal(await f.invoke(get), "not-determined");
    await assert.rejects(async () => f.invoke(request));
    f.invoke(contract.IPC.setAccount, "alice"); f.invoke(contract.IPC.ready);
    f.setState({ focused: true, visible: true, minimized: false });
    assert.equal(await f.invoke(request), "granted");
    assert.equal(await f.invoke(request), "granted");
    assert.equal(f.notificationCalls.filter((call) => call === "request").length, 1);
  } finally { f.stop(); }
});

for (const change of ["navigate", "logout", "blur", "quit", "destroy"]) {
  test(`main notification request revalidates ${change} after passive query before OS prompt`, async () => {
    const f = await fixture(false, { spike: false, notificationPermission: "not-determined" });
    try {
      f.invoke(contract.IPC.setAccount, "alice"); f.invoke(contract.IPC.ready);
      f.setState({ focused: true, visible: true, minimized: false });
      let resolve: ((value: string) => void) | undefined;
      f.setNotificationQuery(() => new Promise((done) => { resolve = done; }));
      const pending = f.invoke("chat-desktop:v1:request-notification-permission");
      await settle(); assert.ok(resolve);
      if (change === "navigate") f.navigate();
      if (change === "logout") f.invoke(contract.IPC.setAccount, null);
      if (change === "blur") f.setState({ focused: false, visible: true, minimized: false });
      if (change === "quit") f.stop();
      if (change === "destroy") f.destroyWindow();
      resolve("not-determined");
      assert.equal(await pending, "unknown");
      assert.equal(f.notificationCalls.includes("request"), false);
    } finally { f.stop(); }
  });
}

test("main opens only the fixed notification Settings URL and only for current denied permission", async () => {
  const f = await fixture(false, { spike: false, notificationPermission: "not-determined" });
  try {
    const channel = "chat-desktop:v1:open-notification-settings";
    await assert.rejects(async () => f.invoke(channel));
    f.invoke(contract.IPC.setAccount, "alice"); f.invoke(contract.IPC.ready);
    f.setState({ focused: true, visible: true, minimized: false });
    await f.invoke(channel);
    assert.equal(f.notificationCalls.some((call) => call.startsWith("x-apple")), false);
    f.setNotificationPermission("denied"); await f.invoke(channel);
    assert.deepEqual(f.notificationCalls.filter((call) => call.startsWith("x-apple")), [
      `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${contract.APP_ID}`,
    ]);
    await assert.rejects(async () => f.invoke(channel, "file:///unsafe"));
  } finally { f.stop(); }
});

for (const change of ["navigate", "logout", "quit", "destroy", "replace-frame", "url", "contents-url"]) {
  test(`main notification permission result is stale after ${change} while OS prompt is pending`, async () => {
    const f = await fixture(false, { spike: false, notificationPermission: "not-determined" });
    try {
      f.invoke(contract.IPC.setAccount, "alice"); f.invoke(contract.IPC.ready);
      f.setState({ focused: true, visible: true, minimized: false });
      let resolve: ((value: string) => void) | undefined;
      f.setNotificationRequest(() => new Promise((done) => { resolve = done; }));
      const pending = f.invoke(contract.IPC.requestNotificationPermission); await settle(); assert.ok(resolve);
      if (change === "navigate") f.navigate();
      if (change === "logout") f.invoke(contract.IPC.setAccount, null);
      if (change === "quit") f.stop();
      if (change === "destroy") f.destroyWindow();
      if (change === "replace-frame") f.contents.mainFrame = { ...f.frame };
      if (change === "url") f.frame.url = `${origin}/other`;
      if (change === "contents-url") f.setContentsURL(`${origin}/other`);
      resolve("granted"); assert.equal(await pending, "unknown");
    } finally { f.stop(); }
  });
}

test("OS consent sheet blur does not discard an otherwise current notification grant", async () => {
  const f = await fixture(false, { spike: false, notificationPermission: "not-determined" });
  try {
    f.invoke(contract.IPC.setAccount, "alice"); f.invoke(contract.IPC.ready);
    f.setState({ focused: true, visible: true, minimized: false });
    f.setNotificationRequest(async () => {
      f.setState({ focused: false, visible: true, minimized: false }); return "granted";
    });
    assert.equal(await f.invoke(contract.IPC.requestNotificationPermission), "granted");
  } finally { f.stop(); }
});

for (const channel of [contract.IPC.getNotificationPermission, contract.IPC.requestNotificationPermission, contract.IPC.openNotificationSettings]) {
  test(`${channel} validates main sender and zero argument contract`, async () => {
    const f = await fixture(false, { spike: false });
    try {
      const handler = f.handlers.get(channel); assert.ok(handler);
      assert.throws(() => f.invoke(channel, "unsafe"));
      for (const sender of [
        { ...f.sender, sender: {} },
        { ...f.sender, senderFrame: { ...f.frame, origin: "https://attacker.example" } },
        { ...f.sender, senderFrame: { ...f.frame, parent: f.frame } },
        { ...f.sender, senderFrame: null },
      ]) assert.throws(() => handler(sender));
      assert.equal(f.notificationCalls.includes("request"), false);
    } finally { f.stop(); }
  });
}

for (const permission of ["denied", "unknown", "not-determined"]) {
  test(`main show rejects macOS ${permission} without requesting authorization`, async () => {
    const f = await fixture(false, { spike: false, notificationPermission: permission });
    try {
      f.invoke(contract.IPC.setAccount, "alice");
      const result = await f.invoke(contract.IPC.showNotification, {
        id: "message-5", accountId: "alice", kind: "message", title: "Title", body: "Body",
        route: { chatId: "chat_1" }, silent: true, expiresAt: Date.now() + 60_000,
      });
      assert.deepEqual(structuredClone(result), { accepted: false, reason: "failed" });
      assert.equal(f.notificationCalls.includes("request"), false);
    } finally { f.stop(); }
  });
}

const audioRequest = () => ({ isMainFrame: true, requestingUrl: `${origin}/`, securityOrigin: origin, mediaTypes: ["audio"] });
const audioCheck = () => ({ isMainFrame: true, requestingUrl: `${origin}/`, securityOrigin: origin, mediaType: "audio" });
const videoRequest = () => ({ ...audioRequest(), mediaTypes: ["video"] });
const videoCheck = () => ({ ...audioCheck(), mediaType: "video" });
const mixedRequest = () => ({ ...audioRequest(), mediaTypes: ["audio", "video"] });
const settle = () => new Promise<void>((done) => setImmediate(done));

for (const status of ["granted", "not-determined"] satisfies MediaStatus[]) {
  test(`main session allows owner audio request with OS ${status}, without startup consent`, async () => {
    const f = await fixture(false, { spike: false, status });
    try {
      assert.equal(f.osCalls.length, 0);
      assert.equal(f.check(audioCheck()), status === "granted");
      assert.equal(f.osCalls.some((call) => call.startsWith("ask:")), false);
      const answers = f.request(audioRequest());
      await settle();
      assert.deepEqual(answers, [true]);
      assert.equal(f.osCalls.filter((call) => call === "ask:microphone").length, status === "not-determined" ? 1 : 0);
      assert.equal(f.check(audioCheck()), true);
    } finally { f.stop(); }
  });
}

for (const status of ["denied", "restricted", "unknown"] satisfies MediaStatus[]) {
  test(`main session fails closed for OS ${status} without repeat consent prompts`, async () => {
    const f = await fixture(false, { spike: false, status });
    try {
      assert.equal(f.check(audioCheck()), false);
      const first = f.request(audioRequest()); const second = f.request(audioRequest());
      await settle();
      assert.deepEqual(first, [false]); assert.deepEqual(second, [false]);
      assert.equal(f.osCalls.some((call) => call.startsWith("ask:")), false);
      assert.match(await f.diagnostic() ?? "", /Системные настройки.*Микрофон.*перезапустите/u);
    } finally { f.stop(); }
  });
}

for (const consentResult of [false, true]) {
  test(`main session rechecks OS status after consent answer ${consentResult}`, async () => {
    const f = await fixture(false, { spike: false, status: "not-determined" });
    try {
      f.setConsent(async () => { f.setMediaStatus("denied"); return consentResult; });
      const first = f.request(audioRequest()); await settle();
      const second = f.request(audioRequest()); await settle();
      assert.deepEqual(first, [false]); assert.deepEqual(second, [false]);
      assert.equal(f.check(audioCheck()), false);
      assert.equal(f.osCalls.filter((call) => call === "ask:microphone").length, 1);
    } finally { f.stop(); }
  });
}

for (const status of ["granted", "not-determined"] satisfies MediaStatus[]) {
  test(`main session allows video with OS ${status}, without startup or microphone access`, async () => {
    const f = await fixture(false, { spike: false, status: "denied", cameraStatus: status });
    try {
      assert.equal(f.osCalls.length, 0);
      assert.equal(f.check(videoCheck()), status === "granted");
      assert.equal(f.osCalls.some((call) => call.startsWith("ask:")), false);
      const answers = f.request(videoRequest()); await settle();
      assert.deepEqual(answers, [true]); assert.equal(f.check(videoCheck()), true);
      assert.equal(f.osCalls.filter((call) => call === "ask:camera").length, status === "not-determined" ? 1 : 0);
      assert.equal(f.osCalls.some((call) => call.includes("microphone")), false);
      const again = f.request(videoRequest()); await settle(); assert.deepEqual(again, [true]);
      assert.equal(f.osCalls.filter((call) => call === "ask:camera").length, status === "not-determined" ? 1 : 0);
    } finally { f.stop(); }
  });
}

for (const status of ["denied", "restricted", "unknown"] satisfies MediaStatus[]) {
  test(`main session camera OS ${status} denies video and mixed, but preserves granted audio`, async () => {
    const f = await fixture(false, { spike: false, cameraStatus: status });
    try {
      assert.equal(f.check(videoCheck()), false);
      for (const request of [videoRequest(), mixedRequest(), audioRequest()]) {
        const answers = f.request(request); await settle();
        assert.deepEqual(answers, [request.mediaTypes.length === 1 && request.mediaTypes[0] === "audio"]);
      }
      assert.equal(f.check(audioCheck()), true);
      assert.equal(f.osCalls.some((call) => call.startsWith("ask:")), false);
      assert.match(await f.diagnostic() ?? "", /Системные настройки.*Камера.*перезапустите/u);
    } finally { f.stop(); }
  });
}

for (const consentResult of [false, true]) {
  test(`main session camera consent ${consentResult} cannot bypass current OS denial`, async () => {
    const f = await fixture(false, { spike: false, cameraStatus: "not-determined" });
    try {
      f.setConsent(async () => { f.setMediaStatus("denied", "camera"); return consentResult; }, "camera");
      const answers = f.request(mixedRequest()); await settle(); assert.deepEqual(answers, [false]);
      const audio = f.request(audioRequest()); await settle(); assert.deepEqual(audio, [true]);
      assert.equal(f.check(videoCheck()), false); assert.equal(f.check(audioCheck()), true);
      assert.deepEqual(f.osCalls.filter((call) => call.startsWith("ask:")), ["ask:camera"]);
    } finally { f.stop(); }
  });
}

for (const status of ["granted", "not-determined"] satisfies MediaStatus[]) {
  for (const cameraStatus of ["granted", "not-determined"] satisfies MediaStatus[]) {
    for (const mediaTypes of [["audio", "video"], ["video", "audio"]]) {
      test(`main session grants ${mediaTypes.join("+")} with microphone ${status} and camera ${cameraStatus}`, async () => {
        const f = await fixture(false, { spike: false, status, cameraStatus });
        try {
          assert.equal(f.osCalls.length, 0);
          const answers = f.request({ ...audioRequest(), mediaTypes }); await settle();
          assert.deepEqual(answers, [true]);
          assert.deepEqual(f.osCalls.filter((call) => call.startsWith("ask:")), [
            ...(status === "not-determined" ? ["ask:microphone"] : []),
            ...(cameraStatus === "not-determined" ? ["ask:camera"] : []),
          ]);
          assert.equal(f.check(audioCheck()), true); assert.equal(f.check(videoCheck()), true);
        } finally { f.stop(); }
      });
    }
  }
}

for (const failure of ["denied", "restricted", "unknown", "consent-denied", "status-error", "ask-sync", "ask-async"]) {
  test(`main session mixed microphone ${failure} never prompts camera; video-only remains independent`, async () => {
    const f = await fixture(false, { spike: false, status: "not-determined", cameraStatus: "not-determined" });
    try {
      if (failure === "denied" || failure === "restricted" || failure === "unknown") f.setMediaStatus(failure);
      else if (failure === "status-error") f.failStatus();
      else f.setConsent(failure === "ask-sync" ? () => { throw new Error("secret URL"); } : async () => {
        if (failure === "ask-async") throw new Error("secret URL");
        f.setMediaStatus("denied"); return false;
      });
      const mixed = f.request(mixedRequest()); await settle(); assert.deepEqual(mixed, [false]);
      assert.equal(f.osCalls.includes("ask:camera"), false);
      assert.match(await f.diagnostic() ?? "", /Системные настройки.*Микрофон.*перезапустите/u);
      const video = f.request(videoRequest()); await settle(); assert.deepEqual(video, [true]);
      assert.equal(f.osCalls.filter((call) => call === "ask:camera").length, 1);
    } finally { f.stop(); }
  });
}

for (const change of ["navigate-back", "reload", "commit", "crash", "destroy", "quit", "metadata"]) {
  test(`main session mixed ${change} while awaiting microphone must not ask camera`, async () => {
    const f = await fixture(false, { spike: false, status: "not-determined", cameraStatus: "not-determined" });
    try {
      let resolveConsent: ((allowed: boolean) => void) | undefined;
      f.setConsent(() => new Promise<boolean>((resolve) => { resolveConsent = resolve; }));
      const details = mixedRequest();
      const answers = f.request(details); await settle(); assert.deepEqual(answers, []); assert.ok(resolveConsent);
      switch (change) {
        case "navigate-back": f.navigate(`${origin}/other`); f.navigate(`${origin}/`); break;
        case "reload": f.navigate(); break;
        case "commit": f.contents.emit("did-navigate"); break;
        case "crash": f.contents.emit("render-process-gone"); break;
        case "destroy": f.destroyWindow(); break;
        case "quit": f.stop(); break;
        case "metadata": details.requestingUrl = `${origin}/other`; break;
      }
      f.setMediaStatus("granted"); resolveConsent(true); await settle();
      assert.deepEqual(answers, [false]);
      assert.deepEqual(f.osCalls.filter((call) => call.startsWith("ask:")), ["ask:microphone"]);
    } finally { f.stop(); }
  });
}

for (const failedKind of [null, "microphone", "camera"] satisfies (MediaKind | null)[]) {
  for (const reject of [false, true]) {
    test(`main session independent concurrent device prompts: failure ${failedKind}, rejection ${reject}`, async () => {
      const f = await fixture(false, { spike: false, status: "not-determined", cameraStatus: "not-determined" });
      try {
        const pending = new Map<MediaKind, { resolve(value: boolean): void; reject(error: Error): void }>();
        for (const kind of ["microphone", "camera"] satisfies MediaKind[]) {
          f.setConsent(() => new Promise<boolean>((resolve, reject) => { pending.set(kind, { resolve, reject }); }), kind);
        }
        const audio = f.request(audioRequest()); const audioAgain = f.request(audioRequest());
        const video = f.request(videoRequest()); const videoAgain = f.request(videoRequest());
        const mixed = f.request(mixedRequest()); await settle();
        assert.deepEqual(audio, []); assert.deepEqual(video, []);
        assert.deepEqual(f.osCalls.filter((call) => call.startsWith("ask:")), ["ask:microphone", "ask:camera"]);
        for (const kind of ["camera", "microphone"] satisfies MediaKind[]) {
          const consent = pending.get(kind); assert.ok(consent);
          if (kind === failedKind) {
            f.setMediaStatus("denied", kind);
            if (reject) consent.reject(new Error("secret URL")); else consent.resolve(false);
          } else { f.setMediaStatus("granted", kind); consent.resolve(true); }
          await settle();
          if (kind === "camera") { assert.deepEqual(audio, []); assert.deepEqual(audioAgain, []); }
        }
        assert.deepEqual(audio, [failedKind !== "microphone"]); assert.deepEqual(audioAgain, audio);
        assert.deepEqual(video, [failedKind !== "camera"]); assert.deepEqual(videoAgain, video);
        assert.deepEqual(mixed, [failedKind === null]);
      } finally { f.stop(); }
    });
  }
}

for (const failure of ["status", "ask-sync", "ask-async"]) {
  test(`main session mixed camera ${failure} preserves the granted microphone`, async () => {
    const f = await fixture(false, { spike: false, cameraStatus: "not-determined" });
    try {
      if (failure === "status") f.failStatus("camera");
      else f.setConsent(failure === "ask-sync" ? () => { throw new Error("secret URL"); } : async () => { throw new Error("secret URL"); }, "camera");
      const mixed = f.request(mixedRequest()); await settle(); assert.deepEqual(mixed, [false]);
      const audio = f.request(audioRequest()); await settle(); assert.deepEqual(audio, [true]);
      assert.equal(f.check(audioCheck()), true); assert.equal(f.check(videoCheck()), false);
      const diagnostic = await f.diagnostic() ?? "";
      assert.match(diagnostic, /Системные настройки.*Камера.*перезапустите/u);
      assert.doesNotMatch(diagnostic, /secret|URL/u);
      assert.equal(f.osCalls.includes("ask:microphone"), false);
    } finally { f.stop(); }
  });
}

for (const kind of ["microphone", "camera"] satisfies MediaKind[]) {
  test(`main session clears only settled ${kind} consent before a new request`, async () => {
    const f = await fixture(false, { spike: false, status: "not-determined", cameraStatus: "not-determined" });
    try {
      f.setConsent(async () => { throw new Error("secret URL"); }, kind);
      const request = kind === "camera" ? videoRequest() : audioRequest();
      const first = f.request(request); await settle(); assert.deepEqual(first, [false]);
      f.setConsent(async () => { f.setMediaStatus("granted", kind); return true; }, kind);
      const second = f.request(request); await settle(); assert.deepEqual(second, [true]);
      assert.deepEqual(f.osCalls.filter((call) => call.startsWith("ask:")), [`ask:${kind}`, `ask:${kind}`]);
      assert.equal(f.osCalls.some((call) => call.includes(kind === "camera" ? "microphone" : "camera")), false);
    } finally { f.stop(); }
  });
}

test("main session mixed prompts are sequential even with reversed media order", async () => {
  const f = await fixture(false, { spike: false, status: "not-determined", cameraStatus: "not-determined" });
  try {
    let resolveMicrophone: ((value: boolean) => void) | undefined;
    let resolveCamera: ((value: boolean) => void) | undefined;
    f.setConsent(() => new Promise<boolean>((resolve) => { resolveMicrophone = resolve; }));
    f.setConsent(() => new Promise<boolean>((resolve) => { resolveCamera = resolve; }), "camera");
    const mixed = f.request({ ...audioRequest(), mediaTypes: ["video", "audio"] }); await settle();
    assert.ok(resolveMicrophone); assert.equal(typeof resolveCamera, "undefined"); assert.deepEqual(mixed, []);
    assert.deepEqual(f.osCalls.filter((call) => call.startsWith("ask:")), ["ask:microphone"]);
    f.setMediaStatus("granted"); resolveMicrophone(true); await settle();
    assert.ok(resolveCamera); assert.deepEqual(mixed, []);
    assert.deepEqual(f.osCalls.filter((call) => call.startsWith("ask:")), ["ask:microphone", "ask:camera"]);
    f.setMediaStatus("denied", "camera"); resolveCamera(false); await settle();
    assert.deepEqual(mixed, [false]);
    const audio = f.request(audioRequest()); await settle(); assert.deepEqual(audio, [true]);
    assert.equal(f.check(audioCheck()), true);
  } finally { f.stop(); }
});

for (const mediaTypes of [["audio"], ["video"], ["audio", "video"]]) {
  test(`main session validates ${mediaTypes.join("+")} at the final callback boundary`, async () => {
    const f = await fixture(false, { spike: false });
    try {
      const answers = f.request({ ...audioRequest(), mediaTypes });
      const navigateAfterAccess = (remaining: number): void => queueMicrotask(() => {
        if (remaining > 1) navigateAfterAccess(remaining - 1);
        else f.navigate();
      });
      navigateAfterAccess(mediaTypes.length);
      await settle(); assert.deepEqual(answers, [false]);
      assert.equal(f.osCalls.some((call) => call.startsWith("ask:")), false);
    } finally { f.stop(); }
  });
}

for (const failStatus of [false, true]) {
  test(`main session mixed final grant rechecks earlier microphone status, error ${failStatus}`, async () => {
    const f = await fixture(false, { spike: false, cameraStatus: "not-determined" });
    try {
      let resolveConsent: ((allowed: boolean) => void) | undefined;
      f.setConsent(() => new Promise<boolean>((resolve) => { resolveConsent = resolve; }), "camera");
      const answers = f.request(mixedRequest()); await settle(); assert.ok(resolveConsent);
      if (failStatus) f.failStatus(); else f.setMediaStatus("denied");
      f.setMediaStatus("granted", "camera"); resolveConsent(true); await settle();
      assert.deepEqual(answers, [false]);
      assert.match(await f.diagnostic() ?? "", /Системные настройки.*Микрофон.*перезапустите/u);
      assert.equal(f.check(videoCheck()), true);
    } finally { f.stop(); }
  });
}

const invalidDetails: [string, PermissionDetails, PermissionDetails][] = [
  ["iframe", { isMainFrame: false }, { isMainFrame: false }],
  ["missing main frame", { isMainFrame: undefined }, { isMainFrame: undefined }],
  ["worker without URL", { requestingUrl: undefined }, { requestingUrl: undefined }],
  ["foreign URL", { requestingUrl: "https://attacker.example/" }, { requestingUrl: "https://attacker.example/" }],
  ["stale same-origin URL", { requestingUrl: `${origin}/other` }, { requestingUrl: `${origin}/other` }],
  ["opaque URL", { requestingUrl: "about:blank" }, { requestingUrl: "about:blank" }],
  ["null origin", { securityOrigin: "null" }, { securityOrigin: "null" }],
  ["foreign security origin", { securityOrigin: "https://attacker.example" }, { securityOrigin: "https://attacker.example" }],
  ["foreign optional requesting origin", { requestingOrigin: "https://attacker.example" }, { requestingOrigin: "https://attacker.example" }],
  ["foreign embedding origin", { embeddingOrigin: "https://attacker.example" }, { embeddingOrigin: "https://attacker.example" }],
  ["unknown media", { mediaTypes: ["unknown"] }, { mediaType: "unknown" }],
  ["missing media", { mediaTypes: undefined }, { mediaType: undefined }],
  ["empty media", { mediaTypes: [] }, { mediaType: "" }],
  ["duplicate media", { mediaTypes: ["audio", "audio"] }, { mediaType: undefined }],
  ["duplicate video", { mediaTypes: ["video", "video"] }, { mediaType: "unknown" }],
  ["duplicate mixed", { mediaTypes: ["audio", "video", "audio"] }, { mediaType: "unknown" }],
  ["mixed unknown", { mediaTypes: ["audio", "unknown"] }, { mediaType: "unknown" }],
  ["screen media", { mediaTypes: ["screen"] }, { mediaType: "screen" }],
  ["non-array media", { mediaTypes: "video" }, { mediaType: ["video"] }],
  ["sparse media", { mediaTypes: new Array<string>(1) }, { mediaType: "unknown" }],
  ["null media", { mediaTypes: null }, { mediaType: null }],
];
for (const [name, request, check] of invalidDetails) {
  for (const mediaTypes of [["audio"], ["video"], ["audio", "video"]]) {
    test(`main session rejects ${name} for ${mediaTypes.join("+")} before OS access`, async () => {
      const f = await fixture(false, { spike: false, status: "not-determined" });
      try {
        assert.equal(f.check({ ...audioCheck(), mediaType: mediaTypes[0], ...check }), false);
        const answers = f.request({ ...audioRequest(), mediaTypes, ...request }); await settle();
        assert.deepEqual(answers, [false]); assert.equal(f.osCalls.length, 0);
      } finally { f.stop(); }
    });
  }
}

for (const permission of ["notifications", "display-capture", "camera", "unknown", "hid", "speaker-selection"]) {
  test(`main session keeps ${permission} denied`, async () => {
    const f = await fixture(false, { spike: false });
    try {
      for (const request of [audioRequest(), videoRequest(), mixedRequest()]) {
        assert.equal(f.check({ ...audioCheck(), mediaType: request.mediaTypes[0] }, permission), false);
        const answers = f.request(request, permission); await settle();
        assert.deepEqual(answers, [false]); assert.equal(f.osCalls.length, 0);
      }
      assert.equal(f.device(), false); assert.equal(JSON.stringify(f.display()), "[{}]");
    } finally { f.stop(); }
  });
}

for (const sender of [null, {}]) {
  test(`main session rejects ${sender === null ? "null worker" : "non-owning contents"}`, async () => {
    const f = await fixture(false, { spike: false });
    try {
      for (const request of [audioRequest(), videoRequest(), mixedRequest()]) {
        assert.equal(f.check({ ...audioCheck(), mediaType: request.mediaTypes[0] }, "media", sender), false);
        const answers = f.request(request, "media", sender); await settle();
        assert.deepEqual(answers, [false]); assert.equal(f.osCalls.length, 0);
      }
    } finally { f.stop(); }
  });
}

for (const url of ["https://attacker.example/", "about:blank", security.ERROR_URL, `${security.SPIKE_ORIGIN}/`]) {
  test(`main session rejects an untrusted current top document (${url})`, async () => {
    const f = await fixture(false, { spike: false });
    try {
      f.frame.url = url;
      for (const request of [audioRequest(), videoRequest(), mixedRequest()]) {
        const answers = f.request({ ...request, requestingUrl: url });
        assert.equal(f.check({ ...audioCheck(), mediaType: request.mediaTypes[0], requestingUrl: url }), false);
        await settle(); assert.deepEqual(answers, [false]); assert.equal(f.osCalls.length, 0);
      }
    } finally { f.stop(); }
  });
}

for (const state of ["opaque-origin", "wrong-contents-URL", "parented-frame", "dead-window", "dead-contents", "dead-frame"]) {
  test(`main session rejects ${state} before checking OS access`, async () => {
    const f = await fixture(false, { spike: false });
    try {
      switch (state) {
        case "opaque-origin": f.frame.origin = "null"; break;
        case "wrong-contents-URL": f.setContentsURL(`${origin}/other`); break;
        case "parented-frame": f.setFrameParent({}); break;
        case "dead-window": f.destroyWindow(); break;
        case "dead-contents": f.destroyContents(); break;
        case "dead-frame": f.destroyFrame(); break;
      }
      for (const request of [audioRequest(), videoRequest(), mixedRequest()]) {
        const answers = f.request(request); await settle();
        assert.deepEqual(answers, [false]);
        assert.equal(f.check({ ...audioCheck(), mediaType: request.mediaTypes[0] }), false);
        assert.equal(f.osCalls.length, 0);
      }
    } finally { f.stop(); }
  });
}

test("main session handles optional origin metadata and Chromium origin URL serialization", async () => {
  const f = await fixture(false, { spike: false });
  try {
    for (const securityOrigin of [undefined, origin, `${origin}/`]) {
      const request = { ...audioRequest(), securityOrigin, requestingOrigin: `${origin}/` };
      const answers = f.request(request); await settle(); assert.deepEqual(answers, [true]);
      assert.equal(f.check({ ...audioCheck(), securityOrigin }, "media", f.contents, `${origin}/`), true);
    }
    assert.equal(f.osCalls.some((call) => call.startsWith("ask:")), false);
  } finally { f.stop(); }
});

for (const kind of ["microphone", "camera"] satisfies MediaKind[]) {
  for (const change of ["navigate", "navigate-back", "same-url-reload", "navigation-commit", "renderer-gone", "destroy-window", "destroy-contents", "destroy-frame", "frame-origin", "replace-frame", "quit"]) {
    test(`main session rejects late ${kind} consent after ${change}, answering only once`, async () => {
      const f = await fixture(false, { spike: false, status: "not-determined", cameraStatus: "not-determined" });
      try {
        let resolveConsent: ((value: boolean) => void) | undefined;
        f.setConsent(() => new Promise<boolean>((resolve) => { resolveConsent = resolve; }), kind);
        if (change === "navigation-commit") f.navigate();
        const answers = f.request(kind === "camera" ? videoRequest() : audioRequest()); await settle();
        assert.deepEqual(answers, []); assert.ok(resolveConsent);
        switch (change) {
          case "navigate": f.navigate(`${origin}/other`); break;
          case "navigate-back": f.navigate(`${origin}/other`); f.navigate(`${origin}/`); break;
          case "same-url-reload": f.navigate(); break;
          case "navigation-commit": f.contents.emit("did-navigate"); break;
          case "renderer-gone": f.contents.emit("render-process-gone"); break;
          case "destroy-window": f.destroyWindow(); break;
          case "destroy-contents": f.destroyContents(); break;
          case "destroy-frame": f.destroyFrame(); break;
          case "frame-origin": f.frame.origin = "null"; break;
          case "replace-frame": f.contents.mainFrame = { ...f.frame }; break;
          case "quit": f.stop(); break;
        }
        f.setMediaStatus("granted", kind); resolveConsent(true); resolveConsent(true); await settle();
        assert.deepEqual(answers, [false]);
      } finally { f.stop(); }
    });
  }

  for (const failure of ["status", "ask-sync", "ask-async"]) {
    test(`main session handles ${kind} ${failure} failure without exception leakage`, async () => {
      const f = await fixture(false, { spike: false, status: "not-determined", cameraStatus: "not-determined" });
      try {
        if (failure === "status") f.failStatus(kind);
        else f.setConsent(failure === "ask-sync" ? () => { throw new Error("secret URL"); } : async () => { throw new Error("secret URL"); }, kind);
        const answers = f.request(kind === "camera" ? videoRequest() : audioRequest()); await settle();
        assert.deepEqual(answers, [false]); assert.equal(f.check(kind === "camera" ? videoCheck() : audioCheck()), false);
        const diagnostic = await f.diagnostic() ?? "";
        assert.doesNotMatch(diagnostic, /secret|URL/u);
        assert.match(diagnostic, kind === "camera" ? /Системные настройки.*Камера.*перезапустите/u : /Системные настройки.*Микрофон.*перезапустите/u);
      } finally { f.stop(); }
    });
  }
}

test("main session coalesces concurrent real audio requests into one OS consent", async () => {
  const f = await fixture(false, { spike: false, status: "not-determined" });
  try {
    let resolveConsent: ((value: boolean) => void) | undefined;
    f.setConsent(() => new Promise<boolean>((resolve) => { resolveConsent = resolve; }));
    const first = f.request(audioRequest()); const second = f.request(audioRequest()); await settle();
    assert.equal(f.osCalls.filter((call) => call === "ask:microphone").length, 1);
    assert.ok(resolveConsent); f.setMediaStatus("granted"); resolveConsent(true); await settle();
    assert.deepEqual(first, [true]); assert.deepEqual(second, [true]);
  } finally { f.stop(); }
});

test("main session requires check requestingOrigin to match the trusted origin", async () => {
  const f = await fixture(false, { spike: false });
  try {
    for (const requestingOrigin of ["null", "", "https://attacker.example", `${origin}/other`]) {
      assert.equal(f.check(audioCheck(), "media", f.contents, requestingOrigin), false);
      assert.equal(f.check(videoCheck(), "media", f.contents, requestingOrigin), false);
    }
    assert.equal(f.osCalls.length, 0);
  } finally { f.stop(); }
});

for (const options of [{ spike: true }, { spike: false, platform: "win32" }, { spike: false, platform: "linux" }]) {
  test(`main session preserves deny-only scope for ${JSON.stringify(options)}`, async () => {
    const f = await fixture(false, options);
    try {
      for (const request of [audioRequest(), videoRequest(), mixedRequest()]) {
        assert.equal(f.check({ ...audioCheck(), mediaType: request.mediaTypes[0] }), false);
        const answers = f.request(request); await settle();
        assert.deepEqual(answers, [false]); assert.equal(f.osCalls.length, 0);
      }
    } finally { f.stop(); }
  });
}

test("ready publishes initial native state before flushing a queued activation", async () => {
  const f = await fixture();
  try {
    await show(f); f.click();
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
    await show(f); f.click();
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
