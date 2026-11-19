import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import * as contract from "./contract";
import { resolveConfiguration } from "./config";
import * as lifecycle from "./lifecycle";
import * as mediaPermissions from "./media-permissions";
import * as notifications from "./notifications";
import * as notificationPermissions from "./notification-permission";
import * as security from "./security";
import * as updates from "./updates";
import * as updateIPC from "./update-ipc";
import * as taskbarBadge from "./taskbar-badge";
import * as proxySettings from "./proxy-settings";
import type { UpdatePort, UpdateContext } from "./updates";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopEvent, WindowState } from "./contract";
import type { LinuxDesktopIntegrationPort } from "./linux-desktop-integration";
import type { NativeCallbacks, NotificationMetadata, NotificationNativePort } from "./notifications";

const origin = "https://chat.example";

test("first-run proxy save applies to the initial chat load and both updater routes", async () => {
  const proxy = { mode: "fixed_servers", proxyRules: "socks5://localhost:1080", proxyBypassRules: "<-loopback>" };
  const f = await fixture(false, { spike: false, savedServer: null, serverChoice: `${origin}/`,
    firstRunProxy: { mode: "socks5", scope: "all", host: "localhost", port: 1080 } });
  try {
    assert.ok(f.serverPrompts[0]?.proxy);
    assert.deepEqual(f.routeCalls, [proxy, "disable_non_proxied_udp", `${origin}/`]);
    assert.deepEqual(f.updaterRoutes, [{ metadata: proxy, download: proxy }]);
  } finally { f.stop(); }
});

test("check-only leaves chat untouched; the offline tray action saves and relaunches", async () => {
  const settings = { mode: "system", scope: "check" } as const;
  const f = await fixture(false, { spike: false, proxy: settings });
  try {
    assert.deepEqual(f.routeCalls, [`${origin}/`]);
    assert.deepEqual(f.updaterRoutes, [{ metadata: { mode: "system" }, download: undefined }]);
    const action = f.trayMenus[0]?.find((item) => item.label === "Настройки прокси…");
    assert.ok(action?.click);
    Reflect.apply(action.click, undefined, []);
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(f.proxyPrompts.map(({ current }) => current), [settings]);
    assert.deepEqual(f.serverCalls.slice(-2), ["relaunch", "quit"]);
  } finally { f.stop(); }
});

test("a failed automatic restart after saving proxy still closes the old route", async () => {
  const f = await fixture(false, { spike: false, relaunchFails: true });
  try {
    const action = f.trayMenus[0]?.find((item) => item.label === "Настройки прокси…");
    assert.ok(action?.click);
    Reflect.apply(action.click, undefined, []);
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(f.serverCalls.slice(-2), ["relaunch", "quit"]);
    assert.deepEqual(f.messages, []);
  } finally { f.stop(); }
});

test("damaged settings or a failed proxy setup cannot load chat via default networking", async () => {
  for (const options of [{ proxyReadFails: true }, { proxy: { mode: "system", scope: "all" } as const, proxySetupFails: true }]) {
    const f = await fixture(false, { spike: false, ...options });
    try {
      assert.deepEqual(f.loads, [security.ERROR_URL]);
      assert.equal(f.updateCalls.includes("check"), false);
      assert.ok(f.trayMenus[0]?.some((item) => item.label === "Настройки прокси…"));
    } finally { f.stop(); }
  }
});
const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/main.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);
const source = compiled.stdout;

type MediaStatus = ReturnType<Electron.SystemPreferences["getMediaAccessStatus"]>;
type MediaKind = "microphone" | "camera";
type PermissionDetails = Record<string, unknown>;
type RequestHandler = (contents: unknown, permission: string, callback: (allowed: boolean) => void, details: unknown) => void;
type CheckHandler = (contents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean;

async function fixture(cold = false, options: { proxy?: proxySettings.ProxySettings; proxyReadFails?: boolean; proxySetupFails?: boolean; firstRunProxy?: proxySettings.ProxySettings; savedServer?: string | null; serverChoice?: string | null; serverWriteFails?: boolean; serverReadFails?: boolean; relaunchFails?: boolean; environmentURL?: string; updates?: boolean; spike?: boolean; platform?: string; status?: MediaStatus; cameraStatus?: MediaStatus; notificationPermission?: string; realNotificationPermission?: boolean; badgeResult?: boolean; appImage?: string; captureBadgeTimers?: boolean } = {}) {
  const integrationPorts: LinuxDesktopIntegrationPort[] = [];
  const integrationCalls: boolean[] = [];
  const badgeRefreshes: (() => void)[] = [];
  const integrationPrompts: Electron.MessageBoxOptions[] = [];
  let integrationAnswer: () => Promise<number> = async () => 1;
  const serverCalls: string[] = [];
  const serverPrompts: { initialURL: string; switching: boolean; signal: AbortSignal; proxy?: { save(value: unknown): void } }[] = [];
  const routeCalls: unknown[] = [];
  const updaterRoutes: unknown[] = [];
  const proxyPrompts: { current: proxySettings.ProxySettings; save(value: unknown): void }[] = [];
  let savedProxy = options.proxy;
  let serverChoice: () => Promise<string | null> = async () => options.serverChoice ?? null;
  const events: DesktopEvent[] = [];
  const badgeCalls: number[] = [];
  const overlayCalls: { image: unknown; description: string; window: number }[] = [];
  const bitmapCalls: { pixels: Buffer; width: number; height: number }[] = [];
  let overlayFails = false;
  const startupCalls: string[] = [];
  const windowOptions: Electron.BrowserWindowConstructorOptions[] = [];
  const images: { source: string; template: boolean; size?: { width: number; height: number } }[] = [];
  const trayImages: unknown[] = [];
  const image = (source: string) => {
    const value: (typeof images)[number] = { source, template: false };
    images.push(value);
    return { source,
      setTemplateImage(template: boolean) { value.template = template; },
      resize(size: { width: number; height: number }) { value.size = size; return this; },
    };
  };
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const power = new EventEmitter();
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setPath() {}, setAppUserModelId() {}, enableSandbox() {},
    setDesktopName: (name: string) => { startupCalls.push(`desktop-name:${name}`); },
    getPath: () => "/unused-test-profile", getVersion: () => "0.1.0", requestSingleInstanceLock: () => true,
    whenReady: async () => { startupCalls.push("when-ready"); },
    setBadgeCount: (count: number) => { badgeCalls.push(count); return options.badgeResult ?? true; },
    relaunch() { serverCalls.push("relaunch"); if (options.relaunchFails) throw new Error("private-path"); }, quit() { serverCalls.push("quit"); }, exit() {},
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
  const messages: { message: string; detail?: string }[] = [];
  const reloadPrompts: Electron.MessageBoxOptions[] = [];
  const reloadCalls: string[] = [];
  const loads: string[] = [];
  let loading = false;
  let reloadAnswer: () => Promise<number> = async () => 1;
  const applicationMenus: MenuItemConstructorOptions[][] = [];
  const trayMenus: MenuItemConstructorOptions[][] = [];
  const frame = { origin, url: `${origin}/`, get parent() { return frameParent; }, isDestroyed: () => frameDestroyed,
    send: (_channel: string, event: DesktopEvent) => { events.push(structuredClone(event)); } };
  let windowOpen: ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse) | undefined;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => contentsDestroyed,
    isLoadingMainFrame: () => loading,
    reloadIgnoringCache: () => { reloadCalls.push(frame.url); },
    setWebRTCIPHandlingPolicy(policy: string) { routeCalls.push(policy); },
    setWindowOpenHandler(handler: typeof windowOpen) { windowOpen = handler; }, getURL: () => contentsURL ?? frame.url,
  });
  let rootWindow: Window | undefined;
  class Window extends EventEmitter {
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super(); startupCalls.push("window"); windowOptions.push(options); rootWindow = this;
    }
    readonly windowNumber = windowOptions.length + 1;
    setOverlayIcon(image: unknown, description: string) {
      if (overlayFails) throw new Error("private OS details");
      overlayCalls.push({ image, description, window: this.windowNumber });
    }
    webContents = contents;
    isDestroyed() { return destroyed; }
    isFocused() { return state.focused; }
    isVisible() { return state.visible; }
    isMinimized() { return state.minimized; }
    restore() { state = { ...state, minimized: false }; }
    show() { state = { ...state, visible: true }; }
    focus() { state = { ...state, focused: true }; this.emit("focus"); }
    hide() { state = { ...state, visible: false }; }
    minimize() { state = { ...state, minimized: true }; }
    async loadURL(url: string) { loads.push(url); routeCalls.push(url); }
  }
  const ses = Object.assign(new EventEmitter(), {
    async setProxy(value: Electron.ProxyConfig) {
      routeCalls.push(structuredClone(value));
      if (options.proxySetupFails) throw new Error("private proxy");
    },
    setPermissionRequestHandler(handler: RequestHandler) { requestHandler = handler; },
    setPermissionCheckHandler(handler: CheckHandler) { checkHandler = handler; },
    setDevicePermissionHandler(handler: () => boolean) { deviceHandler = handler; },
    setDisplayMediaRequestHandler(handler: typeof displayHandler) { displayHandler = handler; }, protocol: { handle() {} },
  });
  class Tray extends EventEmitter {
    constructor(icon: unknown) { super(); trayImages.push(icon); }
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
  let authSuccess: (() => void) | undefined;
  const externalPrompts: { parent: unknown; url: string; signal: AbortSignal }[] = [];
  let confirmLink: (signal: AbortSignal) => Promise<boolean> = async () => false;
  const updateCalls: string[] = [];
  let confirmUpdate: (context: UpdateContext) => Promise<boolean> = async () => true;
  let updateInstall: (failed: () => void) => void = () => { updateCalls.push("install"); };
  const updatePort: UpdatePort = {
    check: async () => { updateCalls.push("check"); return { version: "0.1.1-preview.3", releaseURL: "https://github.com/do-service/chat-apps/releases/tag/v0.1.1-preview.3" }; },
    download: async () => { updateCalls.push("download"); },
    confirm: (context) => { updateCalls.push("confirm"); return confirmUpdate(context); },
    install: (failed) => updateInstall(failed), dispose: () => { updateCalls.push("dispose"); },
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
      nativeImage: {
        createFromBitmap: (pixels: Buffer, options: { width: number; height: number }) => {
          bitmapCalls.push({ pixels: Buffer.from(pixels), width: options.width, height: options.height });
          return image("bitmap");
        },
        createFromPath: (path: string) => image(path),
      },
      powerMonitor: power, protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => ses },
      shell: { openExternal: async (url: string) => { notificationCalls.push(url); } }, dialog: {
        showErrorBox: (_title: string, message: string) => { messages.push({ message }); },
        showMessageBox: async (parent: unknown, options?: Electron.MessageBoxOptions) => {
          if (options?.message === "Добавить Chat в меню приложений?") {
            integrationPrompts.push(options);
            return { response: await integrationAnswer() };
          }
          if (options?.message === "Перезагрузить клиент?" || (contract.isRecord(parent) && parent.message === "Перезагрузить клиент?")) {
            const value = options ?? parent;
            assert.ok(contract.isRecord(value) && typeof value.message === "string");
            reloadPrompts.push({ ...value, message: value.message });
            return { response: await reloadAnswer() };
          }
          assert.ok(contract.isRecord(parent) && typeof parent.message === "string");
          messages.push({ message: parent.message, ...(typeof parent.detail === "string" ? { detail: parent.detail } : {}) });
          return { response: 0 };
        },
      }, Tray,
    },
    "node:crypto": { randomUUID: () => "test-auth" },
    "node:fs": { existsSync: () => false }, "node:path": { join: (...parts: string[]) => parts.join("/") },
    "./proxy-settings": { ...proxySettings,
      readProxySettings: () => {
        if (options.proxyReadFails && !savedProxy) throw new Error("private proxy file");
        return savedProxy ?? proxySettings.defaultProxySettings;
      },
      writeProxySettings: (_path: string, value: unknown) => { savedProxy = proxySettings.parseProxySettings(value); return savedProxy; },
    },
    "./server-store": {
      readServerSelection: () => {
        serverCalls.push("read");
        if (options.serverReadFails) throw new Error("private-path");
        return options.savedServer === undefined ? `${origin}/` : options.savedServer;
      },
      writeServerSelection: (_path: string, url: string) => {
        serverCalls.push(`save:${url}`);
        if (options.serverWriteFails) throw new Error("private-path");
      },
    },
    "./server-selection": {
      selectServer: (request: (typeof serverPrompts)[number]) => {
        serverPrompts.push(request);
        if (options.firstRunProxy) request.proxy?.save(options.firstRunProxy);
        return serverChoice();
      },
      configureProxy: async (request: (typeof proxyPrompts)[number]) => {
        proxyPrompts.push(request);
        request.save({ mode: "system", scope: "all" });
        return true;
      },
    },
    "./linux-desktop-integration": { createLinuxDesktopIntegration: (port: LinuxDesktopIntegrationPort) => {
      integrationPorts.push(port);
      return async (manual = false) => { integrationCalls.push(manual); };
    } },
    "./contract": contract, "./security": security, "./lifecycle": lifecycle, "./media-permissions": mediaPermissions, "./notifications": notifications,
    "./updates": updates, "./update-ipc": updateIPC, "./taskbar-badge": taskbarBadge,
    "./electron-updates": { createElectronUpdatePort: (_config: unknown, _os: unknown, _owner: unknown, routes: unknown) => {
      updaterRoutes.push(structuredClone(routes));
      return { mode: options.updates ? "install" : "unconfigured", port: updatePort };
    } },
    "./config": { resolveConfiguration: (_args: string[], url: string | undefined) => options.spike === false
      ? resolveConfiguration([], url, { appUrl: origin })
      : { spike: true, trustedOrigin: origin, appURL: `${origin}/`, partition: "test", profileKey: "test" } },
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
    "./desktop-auth": { DesktopAuthService: class {
      constructor(options: { onSuccess: () => void }) { authSuccess = options.onSuccess; }
      dispose() {}
    } },
    "./electron-auth": { installAuthCookieBarrier: () => ({}) },
    "./external-link-dialog": { confirmExternalLink: (request: (typeof externalPrompts)[number]) => {
      externalPrompts.push(request); return confirmLink(request.signal);
    } },
  };
  runInNewContext(source, {
    require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; },
    __dirname: "/unused-test-bundle", process: { platform: options.platform ?? "darwin", argv: [], env: { ...(options.environmentURL === undefined ? {} : { DESKTOP_APP_URL: options.environmentURL }), ...(options.appImage === undefined ? {} : { APPIMAGE: options.appImage }) } },
    console: { info() {}, error() {} }, Buffer, AbortController, setImmediate,
    setTimeout: (callback: () => void, delay?: number) => {
      if (options.captureBadgeTimers && (delay === 1000 || delay === 3000)) {
        badgeRefreshes.push(callback); return { unref() {} };
      }
      return setTimeout(callback, delay);
    }, clearTimeout, setInterval, clearInterval,
  });
  await new Promise<void>((done) => setImmediate(done));
  if (!options.serverReadFails && !(options.savedServer === null && options.serverWriteFails)
    && (options.savedServer !== null || options.serverChoice)) assert.ok(handlers.has(contract.IPC.ready));
  const sender = { sender: contents, senderFrame: frame };
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel); assert.ok(handler, `Missing handler ${channel}`);
    return handler(sender, ...args);
  };
  return { events, handlers, sender, invoke, power, stop: () => app.emit("before-quit"),
    setState: (value: WindowState) => { state = value; },
    getState: () => state,
    click: () => { assert.ok(callbacks); callbacks.click(); },
    contents, frame, osCalls, notificationCalls, applicationMenus, trayMenus, createdNotifications,
    badgeCalls, overlayCalls, bitmapCalls, startupCalls, windowOptions, images, trayImages, messages, externalPrompts,
    setOverlayFails: (value: boolean) => { overlayFails = value; },
    updateCalls, serverCalls, serverPrompts, reloadPrompts, reloadCalls, loads, routeCalls, updaterRoutes, proxyPrompts,
    integrationPorts, integrationCalls, integrationPrompts, badgeRefreshes,
    setIntegrationAnswer: (value: typeof integrationAnswer) => { integrationAnswer = value; },
    setReloadAnswer: (answer: typeof reloadAnswer) => { reloadAnswer = answer; },
    setLoading: (value: boolean) => { loading = value; },
    setServerChoice: (choose: typeof serverChoice) => { serverChoice = choose; },
    setUpdateConfirmation: (value: typeof confirmUpdate) => { confirmUpdate = value; },
    setUpdateInstall: (value: typeof updateInstall) => { updateInstall = value; },
    close: () => { let prevented = false; assert.ok(rootWindow); rootWindow.emit("close", { preventDefault: () => { prevented = true; } }); return prevented; },
    setLinkConfirmation: (value: typeof confirmLink) => { confirmLink = value; },
    popup: (url: string, postBody?: Electron.PostBody) => {
      assert.ok(windowOpen);
      return windowOpen({ url, frameName: "", features: "", disposition: "new-window", referrer: { url: frame.url, policy: "default" }, ...(postBody ? { postBody } : {}) });
    },
    windowEvent: (event: string) => { assert.ok(rootWindow); rootWindow.emit(event); },
    authSuccess: () => { assert.ok(authSuccess); authSuccess(); },
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
    request: (details: unknown, permission = "media", senderContents: unknown = contents) => {
      assert.ok(requestHandler);
      const answers: boolean[] = [];
      requestHandler(senderContents, permission, (allowed) => answers.push(allowed), details);
      return answers;
    },
    check: (details: unknown, permission = "media", senderContents: unknown = contents, requestingOrigin = origin) => {
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

const reloadChannel = "chat-desktop:v1:reload-client";

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} reload menu/tray/accelerator and IPC share one cancel-default confirmation`, async () => {
    const f = await fixture(false, { platform });
    try {
      const items = f.applicationMenus[0]?.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : []) ?? [];
      const action = items.find((item) => item.label === "Перезагрузить клиент…"); assert.ok(action?.click);
      assert.equal(action.accelerator, "CommandOrControl+Shift+R");
      assert.equal(f.trayMenus[0]?.find((item) => item.label === action.label)?.click, action.click);
      f.frame.url = `${origin}/chats/42?thread=7#message`;
      let answer: ((value: number) => void) | undefined;
      f.setReloadAnswer(() => new Promise((resolve) => { answer = resolve; }));
      Reflect.apply(action.click, undefined, []);
      const pending = f.invoke(reloadChannel);
      assert.equal(f.reloadPrompts.length, 1); assert.ok(answer);
      const prompt = f.reloadPrompts[0]; assert.ok(prompt);
      assert.equal(prompt.message, "Перезагрузить клиент?");
      assert.equal(prompt.detail, "Текущий звонок и передача файлов могут быть прерваны.");
      assert.deepEqual(Array.from(prompt.buttons ?? []), ["Перезагрузить", "Отмена"]);
      assert.equal(prompt.cancelId, 1); assert.equal(prompt.defaultId, 1);
      answer(0); await pending; await settle();
      assert.deepEqual(f.reloadCalls, [f.frame.url]);
      assert.deepEqual(f.loads, [`${origin}/`]);
      assert.equal(f.serverCalls.includes("relaunch"), false);
      f.setReloadAnswer(async () => 1); await f.invoke(reloadChannel);
      assert.equal(f.reloadCalls.length, 1);
      f.setReloadAnswer(async () => { throw new Error("private-error"); });
      await assert.rejects(async () => f.invoke(reloadChannel));
      assert.equal(f.reloadCalls.length, 1);
    } finally { f.stop(); }
  });
}

for (const change of ["navigate", "navigate-back", "same-document", "account", "crash", "commit", "quit", "destroy-window", "destroy-contents", "destroy-frame", "replace-frame", "frame-url", "contents-url", "origin", "loading", "closed"]) {
  test(`reload confirmation cannot outlive ${change}`, async () => {
    const f = await fixture();
    try {
      let answer: ((value: number) => void) | undefined;
      f.setReloadAnswer(() => new Promise((resolve) => { answer = resolve; }));
      const pending = f.invoke(reloadChannel); assert.ok(answer);
      if (change === "navigate") f.navigate();
      if (change === "navigate-back") { f.navigate(`${origin}/other`); f.navigate(`${origin}/`); }
      if (change === "same-document") f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      if (change === "account") f.invoke(contract.IPC.setAccount, "bob");
      if (change === "crash") f.contents.emit("render-process-gone");
      if (change === "commit") f.contents.emit("did-navigate");
      if (change === "quit") f.stop();
      if (change === "destroy-window") f.destroyWindow();
      if (change === "destroy-contents") f.destroyContents();
      if (change === "destroy-frame") f.destroyFrame();
      if (change === "replace-frame") f.contents.mainFrame = { ...f.frame };
      if (change === "frame-url") f.frame.url = `${origin}/other`;
      if (change === "contents-url") f.setContentsURL(`${origin}/other`);
      if (change === "origin") f.frame.origin = "https://attacker.example";
      if (change === "loading") f.setLoading(true);
      if (change === "closed") f.windowEvent("closed");
      answer(0); await pending; assert.deepEqual(f.reloadCalls, []);
      assert.equal(f.loads.includes(`${origin}/`), true);
      assert.equal(f.loads.filter((url) => url === `${origin}/`).length, 1);
    } finally { f.stop(); }
  });
}

test("reload IPC rejects arbitrary arguments and non-current/untrusted senders before prompting", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.invoke(reloadChannel, origin));
    const handler = f.handlers.get(reloadChannel); assert.ok(handler);
    for (const sender of [{ sender: {}, senderFrame: f.frame }, { ...f.sender, senderFrame: null }]) assert.throws(() => handler(sender));
    f.setFrameParent({}); assert.throws(() => f.invoke(reloadChannel)); f.setFrameParent(null);
    f.frame.origin = "https://attacker.example"; assert.throws(() => f.invoke(reloadChannel));
    assert.deepEqual(f.reloadPrompts, []);
  } finally { f.stop(); }
});

for (const invalid of ["foreign", "loading", "mismatched-url"]) {
  test(`native reload refuses initial ${invalid} document without prompting or recovery`, async () => {
    const f = await fixture();
    try {
      if (invalid === "foreign") { f.frame.url = "https://attacker.example/"; f.frame.origin = "https://attacker.example"; }
      if (invalid === "loading") f.setLoading(true);
      if (invalid === "mismatched-url") f.setContentsURL(`${origin}/other`);
      const action = f.trayMenus[0]?.find((item) => item.label === "Перезагрузить клиент…"); assert.ok(action?.click);
      Reflect.apply(action.click, undefined, []); await settle();
      assert.deepEqual(f.reloadPrompts, []); assert.deepEqual(f.reloadCalls, []);
      assert.deepEqual(f.loads, [`${origin}/`]);
    } finally { f.stop(); }
  });
}

for (const state of [{ focused: false, visible: false, minimized: false }, { focused: false, visible: true, minimized: true }]) {
  test(`tray reload makes hidden/minimized owner visible before prompting: ${JSON.stringify(state)}`, async () => {
    const f = await fixture();
    try {
      f.setState(state);
      f.setReloadAnswer(async () => {
        assert.deepEqual(f.getState(), { focused: true, visible: true, minimized: false });
        return 1;
      });
      const action = f.trayMenus[0]?.find((item) => item.label === "Перезагрузить клиент…"); assert.ok(action?.click);
      Reflect.apply(action.click, undefined, []); await settle();
      assert.deepEqual(f.getState(), { focused: true, visible: true, minimized: false });
      assert.equal(f.reloadPrompts.length, 1); assert.deepEqual(f.reloadCalls, []);
    } finally { f.stop(); }
  });
}

for (const unavailable of ["error", "blank", "contents", "missing"]) {
  test(`native reload recovers ${unavailable} only to fixed config URL after consent`, async () => {
    const f = await fixture();
    try {
      if (unavailable === "error") f.frame.url = security.ERROR_URL;
      if (unavailable === "blank") f.frame.url = "about:blank";
      if (unavailable === "contents") f.destroyContents();
      if (unavailable === "missing") f.windowEvent("closed");
      f.setReloadAnswer(async () => 0);
      const action = f.trayMenus[0]?.find((item) => item.label === "Перезагрузить клиент…"); assert.ok(action?.click);
      Reflect.apply(action.click, undefined, []); await settle();
      assert.equal(f.reloadPrompts.length, 1);
      assert.deepEqual(f.reloadCalls, []);
      assert.equal(f.loads.filter((url) => url === `${origin}/`).length, 2);
      if (unavailable === "contents" || unavailable === "missing") assert.equal(f.windowOptions.length, 2);
    } finally { f.stop(); }
  });
}

test("updates IPC keeps exact noargs, trusted main document and foreground mutation guards", async () => {
  const f = await fixture(false, { updates: true });
  try {
    for (const channel of Object.values(updateIPC.UPDATE_IPC)) assert.throws(() => f.invoke(channel, undefined), /arguments/);
    assert.throws(() => f.invoke(updateIPC.UPDATE_IPC.download), /operation failed/);
    const get = f.handlers.get(updateIPC.UPDATE_IPC.getState); assert.ok(get);
    assert.throws(() => get({ sender: {}, senderFrame: f.frame }), /sender rejected/);
    f.setFrameParent({}); assert.throws(() => f.invoke(updateIPC.UPDATE_IPC.getState), /sender rejected/); f.setFrameParent(null);
    f.setState({ focused: true, visible: true, minimized: false });
    await f.invoke(updateIPC.UPDATE_IPC.download); await settle();
    assert.deepEqual(f.updateCalls, ["check", "download"]);
    const caps: unknown = await f.invoke(contract.IPC.capabilities); assert.ok(contract.isRecord(caps)); assert.equal(Object.keys(caps).length, 7);
  } finally { f.stop(); }
});

test("update install prepares quit before upstream close-to-hide and rolls back on event failure", async () => {
  const f = await fixture(false, { updates: true });
  try {
    f.setState({ focused: true, visible: true, minimized: false }); await f.invoke(updateIPC.UPDATE_IPC.download); await settle();
    let closePrevented: boolean | undefined;
    f.setUpdateInstall((failed) => { closePrevented = f.close(); failed(); });
    await f.invoke(updateIPC.UPDATE_IPC.install); assert.equal(closePrevented, false);
    assert.equal(f.close(), true, "failed installer must restore ordinary close-to-hide");
    f.setState({ focused: true, visible: true, minimized: false });
    f.setUpdateInstall(() => { closePrevented = f.close(); });
    await f.invoke(updateIPC.UPDATE_IPC.install); assert.equal(closePrevented, false, "explicit retry retains downloaded installer");
    assert.equal(f.updateCalls.filter((call) => call === "confirm").length, 2);
  } finally { f.stop(); }
});

test("late native updater consent cannot survive navigation, account change, hidden window or Quit", async () => {
  for (const invalidate of ["navigation", "account", "hidden", "quit"]) {
    const f = await fixture(false, { updates: true });
    try {
      f.setState({ focused: true, visible: true, minimized: false }); await f.invoke(updateIPC.UPDATE_IPC.download); await settle();
      let finish: ((value: boolean) => void) | undefined;
      f.setUpdateConfirmation(() => new Promise((resolve) => { finish = resolve; }));
      const pending = f.invoke(updateIPC.UPDATE_IPC.install); assert.ok(finish);
      if (invalidate === "navigation") f.navigate();
      if (invalidate === "account") f.invoke(contract.IPC.setAccount, "alice");
      if (invalidate === "hidden") f.setState({ focused: false, visible: false, minimized: false });
      if (invalidate === "quit") f.stop();
      finish(true); await pending; assert.equal(f.updateCalls.includes("install"), false);
    } finally { f.stop(); }
  }
});

test("external HTTPS link uses the custom dialog and opens only the original confirmed URL", async () => {
  const f = await fixture();
  try {
    f.setState({ focused: true, visible: true, minimized: false });
    f.setLinkConfirmation(async () => true);
    assert.deepEqual(structuredClone(f.popup("https://example.com:8443/docs?q=one#section")), { action: "deny" });
    await settle();
    assert.equal(f.externalPrompts.length, 1);
    assert.equal(f.externalPrompts[0]?.url, "https://example.com:8443/docs?q=one#section");
    assert.deepEqual(f.notificationCalls.filter((value) => value.startsWith("https:")), ["https://example.com:8443/docs?q=one#section"]);
    assert.deepEqual(f.messages, []);
  } finally { f.stop(); }
});

test("external link cancellation and failed dialog never open a URL and allow a later retry", async () => {
  const f = await fixture();
  try {
    f.setState({ focused: true, visible: true, minimized: false });
    for (const confirm of [async () => false, async () => { throw new Error("do-not-log-link"); }, async () => true]) {
      f.setLinkConfirmation(confirm); f.popup("https://example.com/"); await settle();
    }
    assert.equal(f.externalPrompts.length, 3);
    assert.deepEqual(f.notificationCalls.filter((value) => value.startsWith("https:")), ["https://example.com/"]);
  } finally { f.stop(); }
});

test("external link policy still denies invalid protocols, credentials, POST and same-origin shell opens", async () => {
  const f = await fixture();
  try {
    f.setState({ focused: true, visible: true, minimized: false });
    f.setLinkConfirmation(async () => true);
    for (const url of ["http://example.com", "javascript:alert(1)", "data:text/html,hi", "file:///tmp/readme", "mailto:a@example.com", "blob:https://example.com/id", "https://user:password@example.com", "https://example.com/\\path", "https://example.com/\n", `https://example.com/${"a".repeat(8192)}`, `${origin}/file.pdf`]) {
      assert.deepEqual(structuredClone(f.popup(url)), { action: "deny" });
    }
    assert.deepEqual(structuredClone(f.popup("https://example.com/", { contentType: "application/x-www-form-urlencoded", data: [] })), { action: "deny" });
    await settle();
    assert.deepEqual(f.externalPrompts, []);
    assert.deepEqual(f.notificationCalls.filter((value) => value.startsWith("https:")), []);
  } finally { f.stop(); }
});

test("only one external link prompt can be pending and duplicates are not queued", async () => {
  const f = await fixture();
  try {
    f.setState({ focused: true, visible: true, minimized: false });
    let answer: ((value: boolean) => void) | undefined;
    f.setLinkConfirmation(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    f.popup("https://first.example/"); f.popup("https://second.example/"); await settle();
    assert.equal(f.externalPrompts.length, 1); assert.ok(answer);
    answer(true); await settle();
    assert.deepEqual(f.notificationCalls.filter((value) => value.startsWith("https:")), ["https://first.example/"]);
    f.setLinkConfirmation(async () => false); f.popup("https://third.example/"); await settle();
    assert.equal(f.externalPrompts.length, 2);
  } finally { f.stop(); }
});

for (const change of ["navigate", "same-document", "account", "quit", "hide", "minimize", "closed", "crash"]) {
  test(`external link pending confirmation is cancelled after ${change}`, async () => {
    const f = await fixture();
    try {
      f.setState({ focused: true, visible: true, minimized: false });
      let answer: ((value: boolean) => void) | undefined;
      f.setLinkConfirmation(() => new Promise<boolean>((resolve) => { answer = resolve; }));
      f.popup("https://example.com/"); await settle();
      assert.equal(f.externalPrompts.length, 1); assert.ok(answer);
      if (change === "navigate") f.navigate();
      else if (change === "same-document") f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      else if (change === "account") f.invoke(contract.IPC.setAccount, "bob");
      else if (change === "quit") f.stop();
      else if (change === "crash") f.contents.emit("render-process-gone");
      else f.windowEvent(change);
      assert.equal(f.externalPrompts[0]?.signal.aborted, true);
      answer(true); await settle();
      assert.deepEqual(f.notificationCalls.filter((value) => value.startsWith("https:")), []);
    } finally { f.stop(); }
  });
}

for (const change of ["destroy-window", "destroy-contents", "destroy-frame", "frame-url", "contents-url", "frame-origin"]) {
  test(`external link answer rechecks the root even without a lifecycle event after ${change}`, async () => {
    const f = await fixture();
    try {
      f.setState({ focused: true, visible: true, minimized: false });
      let answer: ((value: boolean) => void) | undefined;
      f.setLinkConfirmation(() => new Promise<boolean>((resolve) => { answer = resolve; }));
      f.popup("https://example.com/"); await settle(); assert.ok(answer);
      if (change === "destroy-window") f.destroyWindow();
      if (change === "destroy-contents") f.destroyContents();
      if (change === "destroy-frame") f.destroyFrame();
      if (change === "frame-url") f.frame.url = `${origin}/new-document`;
      if (change === "contents-url") f.setContentsURL(`${origin}/new-document`);
      if (change === "frame-origin") f.frame.origin = "https://attacker.example";
      answer(true); await settle();
      assert.deepEqual(f.notificationCalls.filter((value) => value.startsWith("https:")), []);
    } finally { f.stop(); }
  });
}

for (const change of ["navigate", "account", "quit", "destroy", "untrusted", "hidden"]) {
  test(`external link scheduled from an obsolete or unavailable root is ignored after ${change}`, async () => {
    const f = await fixture();
    try {
      f.setState({ focused: true, visible: true, minimized: false });
      f.setLinkConfirmation(async () => true); f.popup("https://example.com/");
      if (change === "navigate") f.navigate();
      if (change === "account") f.invoke(contract.IPC.setAccount, "bob");
      if (change === "quit") f.stop();
      if (change === "destroy") f.destroyWindow();
      if (change === "untrusted") f.frame.origin = "https://attacker.example";
      if (change === "hidden") f.setState({ focused: false, visible: false, minimized: false });
      await settle();
      assert.deepEqual(f.externalPrompts, []);
      assert.deepEqual(f.notificationCalls.filter((value) => value.startsWith("https:")), []);
    } finally { f.stop(); }
  });
}

async function show(f: Awaited<ReturnType<typeof fixture>>) {
  f.invoke(contract.IPC.setAccount, "alice");
  assert.deepEqual(await f.invoke(contract.IPC.showNotification, {
    id: "message-5", accountId: "alice", kind: "message", title: "Title", body: "Body",
    route: { chatId: "chat_1" }, silent: true, expiresAt: Date.now() + 60_000,
  }), { accepted: true });
}

test("Linux AppImage offers explicit integration after ready and shares app/tray retry action", async () => {
  const f = await fixture(false, { platform: "linux", spike: false, appImage: "/Downloads/Chat.AppImage" });
  try {
    assert.equal(f.integrationPorts.length, 1); assert.deepEqual(f.integrationCalls, []);
    const port = f.integrationPorts[0]; assert.ok(port);
    assert.equal(port.options.appImage, "/Downloads/Chat.AppImage");
    assert.equal(port.options.iconSourcePath, "/unused-test-bundle/app-icon.png");
    f.windowEvent("ready-to-show"); await settle();
    assert.deepEqual(f.integrationCalls, [false]);
    const action = f.trayMenus[0]?.find((item) => item.label === "Добавить в меню приложений…"); assert.ok(action?.click);
    assert.ok(f.applicationMenus[0]?.some((item) => Array.isArray(item.submenu) && item.submenu.includes(action)));
    Reflect.apply(action.click, undefined, []); await settle();
    assert.deepEqual(f.integrationCalls, [false, true]);
    const description = { desktopPath: "/home/test/.local/share/applications/chat.desktop", iconPath: "/profile/icon.png",
      appImagePath: "/Downloads/Chat.AppImage", status: "missing" as const };
    assert.equal(await port.confirm(description), false);
    const prompt = f.integrationPrompts.at(-1); assert.ok(prompt);
    assert.equal(prompt.defaultId, 1); assert.equal(prompt.cancelId, 1);
    assert.match(prompt.detail ?? "", /без установки/u); assert.ok(prompt.detail?.includes(description.desktopPath));
    f.setIntegrationAnswer(async () => 0); assert.equal(await port.confirm(description), true);
    f.setIntegrationAnswer(async () => { f.stop(); return 0; });
    assert.equal(await port.confirm(description), false, "late approval after Quit cannot register");
  } finally { f.stop(); }
});

for (const options of [
  { platform: "linux", spike: false }, { platform: "linux", spike: true, appImage: "/Chat.AppImage" },
  { platform: "darwin", spike: false, appImage: "/Chat.AppImage" }, { platform: "win32", spike: false, appImage: "/Chat.AppImage" },
]) test(`no AppImage integration outside production Linux AppImage: ${JSON.stringify(options)}`, async () => {
  const f = await fixture(false, options);
  try { assert.deepEqual(f.integrationPorts, []); }
  finally { f.stop(); }
});

test("Linux registration resends the latest count and never restores previous account data", async () => {
  const f = await fixture(false, { platform: "linux", spike: false, appImage: "/Chat.AppImage", captureBadgeTimers: true });
  try {
    const port = f.integrationPorts[0]; assert.ok(port);
    f.invoke(contract.IPC.setBadge, 12); port.onResult("registered", true);
    assert.equal(f.badgeCalls.at(-1), 12); assert.equal(f.badgeRefreshes.length, 2);
    f.invoke(contract.IPC.setAccount, "bob");
    for (const refresh of f.badgeRefreshes) refresh();
    assert.deepEqual(f.badgeCalls.slice(-2), [0, 0], "cache-refresh timers never replay a captured previous account count");
    f.invoke(contract.IPC.setBadge, 4); f.badgeRefreshes[0]();
    assert.equal(f.badgeCalls.at(-1), 4, "a pending refresh uses the latest authoritative unread value");
    f.windowEvent("show"); assert.equal(f.badgeCalls.at(-1), 4);
    f.stop(); const before = f.badgeCalls.length; port.onResult("registered", true);
    for (const refresh of f.badgeRefreshes) refresh();
    assert.equal(f.badgeCalls.length, before);
  } finally { f.stop(); }
});

for (const platform of ["linux", "darwin", "win32"]) {
  test(`${platform} main advertises only supported badge API and forwards valid counts`, async () => {
    const f = await fixture(false, { platform });
    try {
      const capabilities = f.invoke(contract.IPC.capabilities); assert.ok(contract.isRecord(capabilities));
      assert.equal(capabilities.badge, true);
      f.invoke(contract.IPC.setBadge, 7); f.invoke(contract.IPC.setBadge, 999999); f.invoke(contract.IPC.setBadge, 0);
      assert.deepEqual(f.badgeCalls, platform === "win32" ? [] : [7, 999999, 0]);
      if (platform === "win32") {
        assert.deepEqual(f.overlayCalls.slice(-3).map((call) => call.description), ["Непрочитанных: 7", "Непрочитанных: 999999", ""]);
        assert.ok(f.overlayCalls.at(-3)?.image);
        assert.ok(f.overlayCalls.at(-2)?.image);
        assert.equal(f.overlayCalls.at(-1)?.image, null);
        assert.deepEqual(f.bitmapCalls.slice(-2), [taskbarBadge.renderBadgeBitmap(7), taskbarBadge.renderBadgeBitmap(999999)]);
      } else assert.deepEqual(f.overlayCalls, []);
    } finally { f.stop(); }
  });

  test(`${platform} account switch, logout and auth success clear badge`, async () => {
    const f = await fixture(false, { platform, spike: false });
    try {
      f.invoke(contract.IPC.setAccount, "alice"); f.invoke(contract.IPC.setBadge, 9);
      f.invoke(contract.IPC.setAccount, "bob"); f.invoke(contract.IPC.setBadge, 3);
      f.invoke(contract.IPC.setAccount, null); f.invoke(contract.IPC.setBadge, 2);
      f.authSuccess();
      assert.deepEqual(f.badgeCalls, platform === "win32" ? [] : [0, 9, 0, 3, 0, 2, 0]);
      if (platform === "win32") {
        assert.deepEqual(f.overlayCalls.slice(-7).map((call) => call.description), ["", "Непрочитанных: 9", "", "Непрочитанных: 3", "", "Непрочитанных: 2", ""]);
        assert.equal(f.overlayCalls.at(-1)?.image, null);
        f.windowEvent("show");
        assert.equal(f.overlayCalls.at(-1)?.image, null, "replay cannot restore the previous account badge");
      }
    } finally { f.stop(); }
  });

  test(`${platform} uses the same bundled color logo for the main window and tray without a synthetic template`, async () => {
    const f = await fixture(false, { platform });
    try {
      assert.equal(f.windowOptions.length, 1); assert.equal(f.trayImages.length, 1);
      assert.equal(f.windowOptions[0]?.icon, "/unused-test-bundle/app-icon.png");
      assert.equal(f.images.length, 1);
      assert.equal(f.images[0]?.source, "/unused-test-bundle/app-icon.png");
      assert.equal(f.images[0]?.template, false);
      assert.deepEqual(structuredClone(f.images[0]?.size), { width: 20, height: 20 });
      assert.ok(contract.isRecord(f.trayImages[0]));
      assert.equal(f.trayImages[0].source, f.images[0]?.source);
      assert.deepEqual(f.startupCalls, platform === "linux"
        ? [`desktop-name:${contract.APP_ID}.desktop`, "when-ready", "window"] : ["when-ready", "window"]);
    } finally { f.stop(); }
  });
}

for (const platform of ["linux", "win32"]) test(`${platform} badge IPC rejects invalid counts, arity and untrusted documents before OS calls`, async () => {
  const f = await fixture(false, { platform });
  try {
    for (const count of [-1, 1000000, 1.5, NaN, Infinity, "3", null, undefined, {}, []]) {
      assert.throws(() => f.invoke(contract.IPC.setBadge, count));
    }
    assert.throws(() => f.invoke(contract.IPC.setBadge));
    assert.throws(() => f.invoke(contract.IPC.setBadge, 3, 4));
    const handler = f.handlers.get(contract.IPC.setBadge); assert.ok(handler);
    for (const sender of [
      { ...f.sender, sender: {} },
      { ...f.sender, senderFrame: { ...f.frame, origin: "https://attacker.example" } },
      { ...f.sender, senderFrame: { ...f.frame, parent: f.frame } },
      { ...f.sender, senderFrame: null },
    ]) assert.throws(() => handler(sender, 3));
    f.frame.origin = "null"; assert.throws(() => f.invoke(contract.IPC.setBadge, 3));
    assert.deepEqual(f.badgeCalls, []);
    assert.equal(f.overlayCalls.some((call) => call.image !== null), false);
  } finally { f.stop(); }
});

test("Windows latest badge replays on show, ready and replacement without updating a closed owner", async () => {
  const f = await fixture(false, { platform: "win32" });
  try {
    f.invoke(contract.IPC.setBadge, 42);
    for (const event of ["show", "ready-to-show"]) {
      const before = f.overlayCalls.length;
      f.windowEvent(event);
      assert.ok(f.overlayCalls.length > before);
      assert.equal(f.overlayCalls.at(-1)?.description, "Непрочитанных: 42");
    }
    f.windowEvent("closed"); await settle();
    assert.equal(f.windowOptions.length, 2);
    assert.equal(f.overlayCalls.at(-1)?.window, 2);
    assert.equal(f.overlayCalls.at(-1)?.description, "Непрочитанных: 42");
    f.stop();
    const before = f.overlayCalls.length;
    f.windowEvent("show");
    assert.equal(f.overlayCalls.length, before);
  } finally { f.stop(); }
});

test("Windows overlay failure stays safe and retries latest count on show", async () => {
  const f = await fixture(false, { platform: "win32" });
  try {
    f.setOverlayFails(true);
    assert.doesNotThrow(() => f.invoke(contract.IPC.setBadge, 12));
    assert.doesNotThrow(() => f.windowEvent("show"));
    assert.match(await f.diagnostic() ?? "", /Badge недоступен/u);
    f.setOverlayFails(false);
    f.windowEvent("show");
    assert.equal(f.overlayCalls.at(-1)?.description, "Непрочитанных: 12");
  } finally { f.stop(); }
});

for (const badgeResult of [false, true]) {
  test(`Linux badge result ${badgeResult} never guarantees a visible LauncherEntry badge`, async () => {
    const f = await fixture(false, { platform: "linux", badgeResult });
    try {
      assert.equal(f.invoke(contract.IPC.setBadge, 3), undefined);
      assert.deepEqual(f.badgeCalls, [3]);
      const diagnostic = await f.diagnostic() ?? "";
      if (!badgeResult) assert.match(diagnostic, /Badge недоступен/u);
      else assert.doesNotMatch(diagnostic, /Badge недоступен/u);
      const detail = f.messages.at(-1)?.detail ?? "";
      assert.match(detail, /LauncherEntry/u);
      assert.match(detail, /не гарант/u);
      assert.match(detail, /\.desktop/u);
    } finally { f.stop(); }
  });
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
        "Открыть", "Скрыть окно", "Перезагрузить клиент…", "Сменить сервер…", "Диагностика фокуса и ограничений",
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

const clipboardDetails = () => ({ isMainFrame: true, requestingUrl: `${origin}/` });

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} main session allows only sanitized clipboard writes for the live trusted HTTPS document`, async () => {
    const f = await fixture(false, { spike: false, platform });
    try {
      for (const serializedOrigin of [origin, `${origin}/`]) {
        for (const details of [clipboardDetails(), { ...clipboardDetails(), securityOrigin: serializedOrigin,
          requestingOrigin: serializedOrigin, embeddingOrigin: serializedOrigin }]) {
          assert.deepEqual(f.request(details, "clipboard-sanitized-write"), [true]);
          assert.equal(f.check(details, "clipboard-sanitized-write", f.contents, serializedOrigin), true);
        }
      }
      f.frame.url = `${origin}/chat/123?view=thread#message`;
      const details = { ...clipboardDetails(), requestingUrl: f.frame.url };
      assert.deepEqual(f.request(details, "clipboard-sanitized-write"), [true]);
      assert.equal(f.check(details, "clipboard-sanitized-write"), true);
      for (const permission of ["clipboard-read", "deprecated-sync-clipboard-read", "clipboard-write", "notifications", "display-capture", "unknown"]) {
        assert.deepEqual(f.request(details, permission), [false]);
        assert.equal(f.check(details, permission), false);
      }
      assert.equal(f.device(), false); assert.equal(JSON.stringify(f.display()), "[{}]");
      assert.deepEqual(f.osCalls, []);
    } finally { f.stop(); }
  });

  for (const [name, invalid] of [
    ["iframe", { isMainFrame: false }], ["missing main-frame flag", { isMainFrame: undefined }],
    ["non-boolean main-frame flag", { isMainFrame: "true" }],
    ["worker without URL", { requestingUrl: undefined }], ["non-string URL", { requestingUrl: 1 }],
    ["foreign URL", { requestingUrl: "https://attacker.example/" }],
    ["stale same-origin document", { requestingUrl: `${origin}/other` }],
    ["opaque URL", { requestingUrl: "about:blank" }],
    ...["securityOrigin", "requestingOrigin", "embeddingOrigin"].flatMap((key) =>
      ["null", "", "https://attacker.example", `${origin}/other`, null, 1].map((value) =>
        [`invalid ${key} ${String(value)}`, { [key]: value }] satisfies [string, PermissionDetails])),
  ] satisfies [string, PermissionDetails][]) {
    test(`${platform} main clipboard denies ${name}`, async () => {
      const f = await fixture(false, { spike: false, platform });
      try {
        const details = { ...clipboardDetails(), ...invalid };
        assert.deepEqual(f.request(details, "clipboard-sanitized-write"), [false]);
        assert.equal(f.check(details, "clipboard-sanitized-write"), false);
        assert.deepEqual(f.osCalls, []);
      } finally { f.stop(); }
    });
  }

  for (const change of ["spike", "quit", "closed", "dead-window", "dead-contents", "dead-frame", "parented-frame",
    "opaque-origin", "foreign-origin", "foreign-url", "http-url", "error-url", "spike-url", "blank-url", "credentials-url", "contents-url", "throwing-frame", "throwing-contents"]) {
    test(`${platform} main clipboard denies unavailable context ${change}`, async () => {
      const f = await fixture(false, { spike: change === "spike", platform });
      try {
        switch (change) {
          case "quit": f.stop(); break;
          case "closed": f.windowEvent("closed"); break;
          case "dead-window": f.destroyWindow(); break;
          case "dead-contents": f.destroyContents(); break;
          case "dead-frame": f.destroyFrame(); break;
          case "parented-frame": f.setFrameParent({}); break;
          case "opaque-origin": f.frame.origin = "null"; break;
          case "foreign-origin": f.frame.origin = "https://attacker.example"; break;
          case "foreign-url": f.frame.url = "https://attacker.example/"; break;
          case "http-url": f.frame.url = "http://chat.example/"; break;
          case "error-url": f.frame.url = security.ERROR_URL; break;
          case "spike-url": f.frame.url = `${security.SPIKE_ORIGIN}/`; break;
          case "blank-url": f.frame.url = "about:blank"; break;
          case "credentials-url": f.frame.url = "https://user:password@chat.example/"; break;
          case "contents-url": f.setContentsURL(`${origin}/other`); break;
          case "throwing-frame": f.frame.isDestroyed = () => { throw new Error("secret frame error"); }; break;
          case "throwing-contents": f.contents.getURL = () => { throw new Error("secret contents error"); }; break;
        }
        const details = { ...clipboardDetails(), requestingUrl: f.frame.url };
        assert.deepEqual(f.request(details, "clipboard-sanitized-write"), [false]);
        assert.equal(f.check(details, "clipboard-sanitized-write"), false);
        assert.deepEqual(f.osCalls, []);
      } finally { f.stop(); }
    });
  }

  test(`${platform} main clipboard rejects foreign contents, malformed details and check origins`, async () => {
    const f = await fixture(false, { spike: false, platform });
    try {
      for (const contents of [null, {}, Object.assign(new EventEmitter(), { ...f.contents })]) {
        assert.deepEqual(f.request(clipboardDetails(), "clipboard-sanitized-write", contents), [false]);
        assert.equal(f.check(clipboardDetails(), "clipboard-sanitized-write", contents), false);
      }
      for (const details of [null, undefined, true, 1, "", {}, [], { get isMainFrame() { throw new Error("secret metadata error"); } }]) {
        assert.deepEqual(f.request(details, "clipboard-sanitized-write"), [false]);
        assert.equal(f.check(details, "clipboard-sanitized-write"), false);
      }
      for (const requestingOrigin of ["null", "", "https://attacker.example", `${origin}/other`, `${origin}//`]) {
        assert.equal(f.check(clipboardDetails(), "clipboard-sanitized-write", f.contents, requestingOrigin), false);
      }
      assert.deepEqual(f.osCalls, []);
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

test("server selection gates first remote startup and persists only explicit choice", async () => {
  const f = await fixture(false, { spike: false, savedServer: null, serverChoice: "https://other.example/" });
  try {
    assert.equal(f.serverPrompts.length, 1);
    assert.equal(f.serverPrompts[0]?.switching, false);
    assert.deepEqual(f.serverCalls, ["read", "save:https://other.example/"]);
    assert.equal(f.windowOptions.length, 1);
    assert.equal(f.windowOptions[0]?.webPreferences?.additionalArguments?.[0],
      "--chat-desktop-trusted-origin=https://other.example");
  } finally { f.stop(); }
});

test("cancelling first selection quits without creating remote session or window", async () => {
  const f = await fixture(false, { spike: false, savedServer: null });
  try {
    assert.deepEqual(f.serverCalls, ["read", "quit"]);
    assert.equal(f.windowOptions.length, 0);
    assert.equal(f.handlers.size, 0);
  } finally { f.stop(); }
});

test("saved remote server skips picker while diagnostic mode does not read settings", async () => {
  for (const spike of [true, false]) {
    const f = await fixture(false, { spike });
    try {
      assert.equal(f.serverPrompts.length, 0);
      assert.deepEqual(f.serverCalls, spike ? [] : ["read"]);
    } finally { f.stop(); }
  }
});

test("server switch is shared by application and tray menus and relaunches only after persistence", async () => {
  const f = await fixture(false, { spike: false });
  try {
    const menu = f.trayMenus[0]?.find((item) => item.label === "Сменить сервер…");
    assert.ok(menu?.click);
    assert.notEqual(menu.enabled, false);
    f.setServerChoice(async () => "https://other.example/");
    // Electron supplies context arguments; the menu action does not consume them.
    Reflect.apply(menu.click, undefined, []);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.serverPrompts.length, 1);
    assert.equal(f.serverPrompts[0]?.switching, true);
    assert.deepEqual(f.serverCalls, ["read", "save:https://other.example/", "relaunch", "quit"]);
  } finally { f.stop(); }
});

test("cancelled or failed server changes never relaunch and duplicate prompts are coalesced", async () => {
  for (const serverWriteFails of [false, true]) {
    const f = await fixture(false, { spike: false, serverWriteFails });
    try {
      const menu = f.trayMenus[0]?.find((item) => item.label === "Сменить сервер…"); assert.ok(menu?.click);
      let answer: ((url: string | null) => void) | undefined;
      f.setServerChoice(() => new Promise((resolve) => { answer = resolve; }));
      Reflect.apply(menu.click, undefined, []); Reflect.apply(menu.click, undefined, []);
      assert.equal(f.serverPrompts.length, 1);
      assert.ok(answer); answer(serverWriteFails ? "https://other.example/" : null);
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(f.serverCalls.includes("relaunch"), false);
      assert.equal(f.serverCalls.includes("quit"), false);
    } finally { f.stop(); }
  }
});

test("runtime environment pins the server without reading or rewriting saved selection", async () => {
  const f = await fixture(false, { spike: false, savedServer: null, environmentURL: "https://pinned.example/" });
  try {
    assert.deepEqual(f.serverCalls, []);
    assert.equal(f.serverPrompts.length, 0);
    assert.equal(f.windowOptions[0]?.webPreferences?.additionalArguments?.[0], "--chat-desktop-trusted-origin=https://pinned.example");
    assert.equal(f.trayMenus[0]?.find((item) => item.label === "Сменить сервер…")?.enabled, false);
  } finally { f.stop(); }
});

test("same server or late choice after Quit cannot restart or save", async () => {
  for (const quit of [false, true]) {
    const f = await fixture(false, { spike: false });
    try {
      const menu = f.trayMenus[0]?.find((item) => item.label === "Сменить сервер…"); assert.ok(menu?.click);
      let answer: ((url: string | null) => void) | undefined;
      f.setServerChoice(() => new Promise((resolve) => { answer = resolve; }));
      Reflect.apply(menu.click, undefined, []);
      if (quit) f.stop();
      assert.ok(answer); answer(quit ? "https://other.example/" : `${origin}/`);
      await new Promise<void>((done) => setImmediate(done));
      assert.deepEqual(f.serverCalls, ["read"]);
      if (quit) assert.equal(f.serverPrompts[0]?.signal.aborted, true);
    } finally { f.stop(); }
  }
});

test("startup settings I/O failures never create a remote window or expose exception details", async () => {
  for (const failure of [{ serverReadFails: true }, { serverWriteFails: true }]) {
    const f = await fixture(false, { spike: false, savedServer: null, serverChoice: "https://other.example/", ...failure });
    try {
      assert.equal(f.windowOptions.length, 0);
      assert.equal(f.handlers.size, 0);
      assert.equal(f.messages.length, 1);
      assert.equal(f.messages[0]?.message.includes("private-path"), false);
    } finally { f.stop(); }
  }
});

test("relaunch failure leaves the current remote document usable and reports only a safe error", async () => {
  const f = await fixture(false, { spike: false, relaunchFails: true });
  try {
    f.setServerChoice(async () => "https://other.example/");
    const menu = f.trayMenus[0]?.find((item) => item.label === "Сменить сервер…"); assert.ok(menu?.click);
    Reflect.apply(menu.click, undefined, []);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.serverCalls.includes("quit"), false);
    assert.ok(f.invoke(contract.IPC.capabilities));
    assert.equal(f.messages[0]?.message.includes("private-path"), false);
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
