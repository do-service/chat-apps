import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, protocol, session, shell, Tray,
  type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Session,
} from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ID, BRIDGE_VERSION, IPC, isAuthState, isBadgeCount, isIdentifier, isLoginRequest, isNotificationDismissal, isNotificationKey, isNotificationRequest,
  type DesktopAuthState, type DesktopCapabilities, type DesktopEvent, type Platform, type WindowState,
} from "./contract";
import { resolveConfiguration, type RuntimeConfiguration } from "./config";
import { createElectronNotificationPort } from "./electron-notifications";
import { FileMetadataStore } from "./notification-store";
import { NotificationService } from "./notifications";
import { createHiddenRecoveryScheduler, isAbortedNavigation } from "./lifecycle";
import { AuthFailure, DesktopAuthService } from "./desktop-auth";
import { createElectronAuthAttempt, installAuthCookieBarrier } from "./electron-auth";
import {
  ERROR_URL, SPIKE_ORIGIN, TRUSTED_ORIGIN_ARGUMENT, externalHTTPSURL, isAllowedFrameNavigation, isTrustedSender, isTrustedURL,
  loginNavigationDoor, spikeResource,
} from "./security";

app.setName("Chat Desktop Spike");
app.setPath("userData", join(app.getPath("appData"), "Chat Desktop Spike"));
app.setAppUserModelId(APP_ID);
app.enableSandbox();

// Resolve the explicit diagnostic-build marker before Chromium registers custom schemes.
// OS cold activation does not preserve a manually supplied --spike launch argument.
const runtimeConfiguration = (() => {
  try { return configuration(); } catch { return null; }
})();
protocol.registerSchemesAsPrivileged([
  { scheme: "chat-desktop-error", privileges: { standard: true, secure: true } },
  ...(runtimeConfiguration?.spike ? [{ scheme: "chat-spike", privileges: { standard: true, secure: true, supportFetchAPI: true } }] : []),
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let notifications: NotificationService | null = null;
let desktopAuth: DesktopAuthService | null = null;
let compatibilityLogin = false;
let compatibilityDialog: AbortController | null = null;
let quitting = false;
let rendererReady = false;
let pendingFocus = false;
let restoreMissingWindow: (() => void) | null = null;
let externalPrompt = false;
let diagnostic = "Запуск прототипа";
type StartupStage = "configuration" | "waiting-app-ready" | "app-ready" | "creating-session"
  | "installing-session-policy" | "session-policy-installed" | "creating-notification-service"
  | "starting-notification-history" | "notification-history-requested" | "registering-ipc"
  | "creating-window" | "window-created" | "installing-window-policy" | "window-policy-installed"
  | "installing-menus" | "loading-target" | "load-requested" | "window-ready";
let startupStage: StartupStage = "configuration";

function setStartupStage(stage: StartupStage): void {
  startupStage = stage;
  if (runtimeConfiguration?.spike) console.info(`Desktop startup stage: ${stage}`);
}

function focusWindow(): void {
  const window = mainWindow;
  if (quitting) return;
  if (!window || window.isDestroyed()) { pendingFocus = true; restoreMissingWindow?.(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  pendingFocus = false;
}

function windowState(): WindowState {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return { focused: false, visible: false, minimized: false };
  return { focused: window.isFocused(), visible: window.isVisible(), minimized: window.isMinimized() };
}

function platform(): Platform {
  if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") return process.platform;
  throw new Error("Unsupported desktop platform");
}

function configuration(): RuntimeConfiguration {
  let build: unknown = { appUrl: null };
  const path = join(__dirname, "desktop-config.json");
  if (existsSync(path)) build = JSON.parse(readFileSync(path, "utf8"));
  return resolveConfiguration(process.argv, process.env.DESKTOP_APP_URL, build);
}

function trayIcon(): Electron.NativeImage {
  const size = 20;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 2; y < 18; y += 1) {
    for (let x = 2; x < 18; x += 1) {
      if (y > 14 && x > 7) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = process.platform === "darwin" ? 0 : 186;
      pixels[offset + 1] = process.platform === "darwin" ? 0 : 112;
      pixels[offset + 2] = process.platform === "darwin" ? 0 : 32;
      pixels[offset + 3] = 255;
    }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
  if (process.platform === "darwin") icon.setTemplateImage(true);
  return icon;
}

function emit(config: RuntimeConfiguration, event: DesktopEvent): void {
  const window = mainWindow;
  if ((!rendererReady && event.type !== "auth-state") || !window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  const frame = window.webContents.mainFrame;
  if (!isTrustedSender({ expectedContents: true, mainFrame: true, frameOrigin: frame.origin, frameURL: frame.url }, config.trustedOrigin)) return;
  frame.send(IPC.event, event);
}

function authorize(event: IpcMainInvokeEvent, config: RuntimeConfiguration): void {
  const window = mainWindow;
  const frame = event.senderFrame;
  if (!window || window.isDestroyed() || !frame || frame.isDestroyed() || !isTrustedSender({
    expectedContents: event.sender === window.webContents,
    mainFrame: frame === window.webContents.mainFrame && frame.parent === null,
    frameOrigin: frame.origin, frameURL: frame.url,
  }, config.trustedOrigin)) throw new Error("Desktop IPC sender rejected");
}

function registerIPC(config: RuntimeConfiguration, service: NotificationService, badge: boolean): void {
  const handle = (channel: string, count: number, action: (args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      authorize(event, config);
      if (args.length !== count) throw new Error("Invalid desktop IPC arguments");
      try { return action(args); }
      catch { throw new Error("Desktop operation failed"); }
    });
  };
  handle(IPC.capabilities, 0, (): DesktopCapabilities => ({
    version: BRIDGE_VERSION, platform: platform(), notifications: service.supported(),
    notificationPermission: "unknown", badge, lifecycle: true, productionAuth: !config.spike,
  }));
  handle(IPC.getAuthState, 0, () => desktopAuth?.getState() ?? { status: "error", code: "unavailable" });
  handle(IPC.beginLogin, 1, ([request]) => {
    if (!isLoginRequest(request)) throw new Error("Invalid desktop login request");
    compatibilityLogin = false;
    compatibilityDialog?.abort();
    return desktopAuth?.begin(request) ?? { status: "error", code: "unavailable" };
  });
  handle(IPC.cancelLogin, 0, () => { desktopAuth?.cancel(); });
  handle(IPC.setAccount, 1, ([accountId]) => {
    if (accountId !== null && !isIdentifier(accountId)) throw new Error("Invalid account identifier");
    // An already-ready renderer may receive pending activation during account binding.
    emit(config, { type: "window-state", state: windowState() });
    service.setAccount(accountId);
    if (badge) app.setBadgeCount(0);
  });
  handle(IPC.showNotification, 1, ([request]) => {
    if (!isNotificationRequest(request)) throw new Error("Invalid notification");
    return service.show(request);
  });
  handle(IPC.closeNotification, 1, ([key]) => {
    if (!isNotificationKey(key)) throw new Error("Invalid notification key");
    service.close(key);
  });
  handle(IPC.clearNotifications, 0, () => { service.clear(); });
  handle(IPC.dismissNotifications, 1, ([selector]) => {
    if (!isNotificationDismissal(selector)) throw new Error("Invalid notification dismissal");
    service.dismiss(selector);
  });
  handle(IPC.setBadge, 1, ([count]) => {
    if (!isBadgeCount(count)) throw new Error("Invalid badge count");
    if (badge && !app.setBadgeCount(count)) diagnostic = "Badge недоступен в текущем окружении ОС";
  });
  handle(IPC.ready, 0, () => {
    rendererReady = true;
    emit(config, { type: "window-state", state: windowState() });
    service.setReady(true);
  });
}

async function openExternal(config: RuntimeConfiguration, value: string): Promise<void> {
  const url = externalHTTPSURL(value, config.trustedOrigin);
  const window = mainWindow;
  if (!url || externalPrompt || !window || window.isDestroyed()) return;
  externalPrompt = true;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "question", title: "Внешняя ссылка", message: "Открыть HTTPS-ссылку в системном браузере?",
      detail: `Сайт: ${new URL(url).hostname}\nCookies приложения не передаются. Для входа используйте отдельную процедуру подтверждения в системном браузере.`,
      buttons: ["Отмена", "Открыть"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response === 1) await shell.openExternal(url);
  } catch { diagnostic = "Не удалось открыть внешнюю ссылку"; }
  finally { externalPrompt = false; }
}

function installSessionPolicy(ses: Session, config: RuntimeConfiguration): void {
  // D1 grants no browser notification/media/device permissions; native notifications use main APIs.
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.on("file-system-access-restricted", (_event, _details, callback) => callback("deny"));
  ses.on("will-download", (event, item, contents, frame) => {
    const window = mainWindow;
    if (!window || window.isDestroyed() || contents !== window.webContents || !frame
        || frame !== contents.mainFrame || frame.origin !== config.trustedOrigin
        || item.getInitiatorOrigin() !== config.trustedOrigin
        || !isTrustedURL(frame.url, config.trustedOrigin)
        || !isTrustedURL(item.getURL(), config.trustedOrigin)
        || item.getURLChain().length === 0
        || !item.getURLChain().every((url) => isTrustedURL(url, config.trustedOrigin))) {
      event.preventDefault();
      diagnostic = "Загрузка заблокирована политикой D1; Blob/P2P и внешние файлы требуют D5";
      return;
    }
    // Keep the authenticated Electron session and its native save dialog; never shell.openExternal a file URL.
    item.setSaveDialogOptions({ title: "Сохранить файл из Chat" });
    item.once("done", (_downloadEvent, state) => {
      diagnostic = state === "completed" ? "Файл сохранён" : "Загрузка отменена или прервана";
    });
  });
  ses.protocol.handle("chat-desktop-error", (request) => {
    if (request.url !== ERROR_URL || request.method !== "GET") return new Response(null, { status: 404 });
    if (config.spike) console.info("Desktop recovery page: served");
    return new Response("<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><title>Chat Desktop Spike</title><h1>Chat Desktop Spike: страница недоступна</h1><p>Страница закрыта или недоступна. Получение событий этой страницей приостановлено. Проверьте сеть и настройку HTTPS origin, затем используйте меню «Повторить загрузку» или «Диагностика».</p><p>Вход выполняется только в системном браузере с кодом и явным подтверждением. Переходы к IdP внутри приложения запрещены.</p></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" },
    });
  });
  if (config.spike) {
    ses.protocol.handle("chat-spike", async (request) => {
      const resource = spikeResource(request.url);
      if (!resource || request.method !== "GET"
          || ("initiatorOrigin" in request && request.initiatorOrigin !== undefined && request.initiatorOrigin !== SPIKE_ORIGIN)) {
        return new Response(null, { status: 404 });
      }
      try {
        const body = readFileSync(join(__dirname, "spike", resource.file), "utf8");
        return new Response(body, { headers: {
          "Content-Type": resource.contentType, "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
          "X-Content-Type-Options": "nosniff",
        } });
      } catch { return new Response(null, { status: 500 }); }
    });
  }
}

function handleAuthState(config: RuntimeConfiguration, state: DesktopAuthState): void {
  if (!isAuthState(state)) return;
  emit(config, { type: "auth-state", state });
  if (!compatibilityLogin) return;
  const window = mainWindow;
  if (state.status !== "waiting") {
    compatibilityDialog?.abort();
    compatibilityDialog = null;
  }
  if (state.status === "waiting" && !compatibilityDialog && window && !window.isDestroyed()) {
    const controller = new AbortController();
    compatibilityDialog = controller;
    // A parent window is required for cancellable asynchronous message boxes on macOS.
    void dialog.showMessageBox(window, {
      type: "info", title: "Вход в Chat через системный браузер", message: `Код подтверждения: ${state.userCode}`,
      detail: "Введите этот код на странице Chat в системном браузере, затем проверьте аккаунт и явно подтвердите вход. Код действует не более пяти минут. Не передавайте его другим людям.",
      buttons: ["Отменить вход"], defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal,
    }).then(() => {
      if (!controller.signal.aborted && compatibilityDialog === controller) desktopAuth?.cancel();
    }).catch(() => {
      if (!controller.signal.aborted && compatibilityDialog === controller) desktopAuth?.cancel();
    });
  } else if (state.status === "error" || state.status === "denied" || state.status === "expired") {
    compatibilityLogin = false;
    diagnostic = state.status === "error" ? `Вход не выполнен: ${state.code}` : `Вход не выполнен: ${state.status}`;
    if (window && !window.isDestroyed()) void dialog.showMessageBox(window, {
      type: "warning", title: "Вход в Chat", message: diagnostic,
      detail: "Встроенный OAuth не используется. Проверьте доступность обновлённого сервера и повторите вход.",
      buttons: ["Закрыть"], noLink: true,
    }).catch(() => {});
  } else if (state.status === "success" || state.status === "cancelled") compatibilityLogin = false;
}

function interceptLoginNavigation(
  window: BrowserWindow, config: RuntimeConfiguration, url: string, isMainFrame: boolean,
): boolean {
  const door = loginNavigationDoor(url, config.trustedOrigin, isMainFrame);
  if (door === null || !desktopAuth || window !== mainWindow || quitting) return false;
  compatibilityLogin = true;
  handleAuthState(config, desktopAuth.begin({ door }));
  return true;
}

function installWindowPolicy(
  window: BrowserWindow, config: RuntimeConfiguration, service: NotificationService, recoverRoot: () => void,
): void {
  const contents = window.webContents;
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("content-bounds-updated", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (details) => {
    if (interceptLoginNavigation(window, config, details.url, details.isMainFrame)) {
      details.preventDefault();
      return;
    }
    if (!isAllowedFrameNavigation(details.url, config.trustedOrigin, details.isMainFrame)) {
      details.preventDefault();
      diagnostic = "Переход на чужой origin запрещён. Для входа используйте системный браузер";
    }
  });
  contents.on("will-redirect", (details) => {
    if (interceptLoginNavigation(window, config, details.url, details.isMainFrame)) {
      details.preventDefault();
      return;
    }
    if (!isAllowedFrameNavigation(details.url, config.trustedOrigin, details.isMainFrame)) {
      details.preventDefault();
      diagnostic = "Внешний redirect заблокирован; вход возможен только через системный браузер";
      if (details.isMainFrame) {
        let destinationOrigin = "invalid";
        try { destinationOrigin = new URL(details.url).origin; } catch { /* Never log raw navigation input. */ }
        console.error(`Desktop navigation blocked: external redirect origin=${destinationOrigin}`);
        void showErrorPage(window);
      }
    }
  });
  contents.setWindowOpenHandler((details) => {
    if (details.postBody) return { action: "deny" };
    if (contents.mainFrame.origin === config.trustedOrigin && interceptLoginNavigation(window, config, details.url, true)) return { action: "deny" };
    if (isTrustedURL(details.url, config.trustedOrigin)) {
      setImmediate(() => { if (!window.isDestroyed()) void window.loadURL(details.url).catch((error: unknown) => {
        if (!isAbortedNavigation(error)) return showErrorPage(window);
      }); });
    } else {
      setImmediate(() => { void openExternal(config, details.url); });
    }
    return { action: "deny" };
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      rendererReady = false;
      service.setReady(false);
    }
  });
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    diagnostic = `Не удалось загрузить страницу (код ${code})`;
    console.error(`Desktop main-frame load failed code=${code}`);
    void showErrorPage(window);
  });
  contents.on("render-process-gone", () => {
    rendererReady = false;
    service.setReady(false);
    diagnostic = "Renderer завершился; используйте «Повторить загрузку»";
    void showErrorPage(window);
  });
  contents.on("unresponsive", () => { diagnostic = "Renderer не отвечает; получение событий не гарантируется"; });
  contents.on("will-prevent-unload", (event) => { if (quitting) event.preventDefault(); });
  const emitState = () => emit(config, { type: "window-state", state: windowState() });
  window.on("focus", emitState);
  window.on("blur", emitState);
  window.on("show", emitState);
  window.on("hide", emitState);
  window.on("minimize", emitState);
  window.on("restore", emitState);
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (tray || process.platform === "darwin") window.hide();
    else {
      diagnostic = "Tray недоступен: крестик сворачивает окно, чтобы не потерять доступ к приложению";
      window.minimize();
    }
  });
  window.on("closed", () => {
    if (mainWindow !== window) return;
    mainWindow = null;
    rendererReady = false;
    service.setReady(false);
    recoverRoot();
  });
}

async function showErrorPage(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) {
    if (runtimeConfiguration?.spike) console.info("Desktop recovery page: skipped-destroyed");
    return;
  }
  if (window.webContents.getURL() === ERROR_URL) {
    if (runtimeConfiguration?.spike) console.info("Desktop recovery page: skipped-current");
    return;
  }
  if (runtimeConfiguration?.spike) console.info("Desktop recovery page: requested");
  try {
    await window.loadURL(ERROR_URL);
    if (runtimeConfiguration?.spike) console.info("Desktop recovery page: loaded");
  } catch (error) {
    if (isAbortedNavigation(error)) return;
    const code = typeof error === "object" && error !== null && "errno" in error
      && typeof error.errno === "number" && Number.isSafeInteger(error.errno)
      && error.errno >= -100_000 && error.errno <= 0 ? error.errno : "unknown";
    if (runtimeConfiguration?.spike) console.info(`Desktop recovery page: failed code=${code}`);
    diagnostic = "Не удалось показать локальную диагностику; используйте меню приложения";
  }
}

function installMenus(config: RuntimeConfiguration, service: NotificationService, loadTarget: () => void): void {
  const diagnostics = async () => {
    const state = windowState();
    await dialog.showMessageBox({
      type: "info", title: "Chat Desktop Spike — диагностика", message: diagnostic,
      detail: `Режим: ${config.spike ? "локальный --spike" : "HTTPS оболочка"}\nФокус: ${state.focused}; видно: ${state.visible}; свёрнуто: ${state.minimized}\nNative notifications API: ${service.supported()} (не гарантия показа ОС)\nКрестик скрывает окно; «Выход» завершает получение событий.\nСистемный вход: ${config.spike ? "выключен в --spike" : "реализован; сервер и IdP требуют отдельной приёмки"}. Media (D5), frontend notification adapter (D2–D3) не реализованы.`,
    });
  };
  const menuOperation = (operation: () => void) => () => {
    try { operation(); }
    catch { diagnostic = "Операция меню не выполнена; проверьте локальное хранилище и повторите попытку"; }
  };
  const actions: MenuItemConstructorOptions[] = [
    { label: "Открыть", click: focusWindow },
    { label: "Скрыть окно", accelerator: "CommandOrControl+W", click: () => mainWindow?.close() },
    { label: "Повторить загрузку", click: loadTarget },
    { label: "Диагностика фокуса и ограничений", click: () => { void diagnostics().catch(() => { diagnostic = "Диалог диагностики недоступен"; }); } },
    { label: "Тестовое уведомление (--spike)", enabled: config.spike, click: menuOperation(() => {
      if (!config.spike) return;
      service.setAccount("spike-account");
      const result = service.show({
        id: `menu-${Date.now()}`, accountId: "spike-account", kind: "test", title: "Chat Desktop Spike",
        body: "Локальный тест: откройте уведомление из центра ОС", route: { chatId: "spike-chat" },
        silent: true, expiresAt: Date.now() + 60_000,
      });
      diagnostic = result.accepted ? "Тест принят native API; проверьте центр уведомлений ОС" : `Тест не принят: ${result.reason ?? "unknown"}`;
    }) },
    { label: "Очистить уведомления", click: menuOperation(() => service.clear()) },
    { type: "separator" },
    { label: "Выход", accelerator: "CommandOrControl+Q", click: () => app.quit() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Chat Desktop Spike", submenu: actions },
    { label: "Правка", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
  ]));
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip("Chat Desktop Spike — крестик скрывает; Выход завершает");
    tray.setContextMenu(Menu.buildFromTemplate(actions));
    tray.on("click", focusWindow);
  } catch { diagnostic = "Tray недоступен; используйте Dock/menu либо окно приложения"; }
}

// Keep the tray/service alive even when renderer window.close() bypasses BrowserWindow's close event.
// Explicit Quit still proceeds through before-quit and will-quit without relying on window-all-closed.
app.on("window-all-closed", () => {});
app.on("before-quit", () => { quitting = true; compatibilityDialog?.abort(); desktopAuth?.dispose(); notifications?.dispose(); });
app.on("will-quit", () => { tray?.destroy(); });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => focusWindow());
  void start().catch(() => {
    // Electron errors can contain URLs with authentication material; never print the raw exception.
    console.error(`Desktop startup failed at stage ${startupStage}`);
    dialog.showErrorBox("Chat Desktop Spike", `Запуск невозможен. Этап: ${startupStage}. Требуется DESKTOP_APP_URL — HTTPS origin без пути, query, fragment и credentials — или явный --spike. Проверьте сборку и конфигурацию. Системный вход требует обновлённого сервера и отдельной проверки IdP.`);
    app.exit(1);
  });
}

async function start(): Promise<void> {
  setStartupStage("configuration");
  const config = runtimeConfiguration;
  if (!config) throw new Error("Invalid desktop configuration");
  setStartupStage("waiting-app-ready");
  await app.whenReady();
  setStartupStage("app-ready");
  const os = platform();
  setStartupStage("creating-session");
  const ses = session.fromPartition(config.partition);
  setStartupStage("installing-session-policy");
  installSessionPolicy(ses, config);
  const cookieBarrier = config.spike ? null : installAuthCookieBarrier(ses, () =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null);
  setStartupStage("session-policy-installed");
  setStartupStage("creating-notification-service");
  const service = new NotificationService({
    native: createElectronNotificationPort(os),
    store: new FileMetadataStore(join(app.getPath("userData"), "notifications", config.profileKey)),
    emit: (event) => emit(config, event), onActivate: focusWindow,
  });
  notifications = service;
  // Journal loading and central activation subscription run synchronously; OS history is best effort.
  // In particular, a pending macOS Notification.getHistory() must never gate creation of the app window.
  setStartupStage("starting-notification-history");
  void service.initialize().catch(() => {
    diagnostic = "Не удалось восстановить историю уведомлений; окно приложения продолжает работать";
  });
  setStartupStage("notification-history-requested");
  // Windows overlay and desktop-environment-specific Linux badge support are outside D1.
  const badge = os === "darwin";
  setStartupStage("registering-ipc");
  registerIPC(config, service, badge);
  const createWindow = (showWhenReady: boolean): BrowserWindow => {
    setStartupStage("creating-window");
    const window = new BrowserWindow({
      width: 1100, height: 780, minWidth: 640, minHeight: 480, show: false, title: "Chat Desktop Spike",
      webPreferences: {
        session: ses, preload: join(__dirname, "preload.cjs"),
        additionalArguments: [`${TRUSTED_ORIGIN_ARGUMENT}${config.trustedOrigin}`],
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, navigateOnDragDrop: false,
      },
    });
    mainWindow = window;
    setStartupStage("window-created");
    setStartupStage("installing-window-policy");
    installWindowPolicy(window, config, service, () => recoverRoot());
    setStartupStage("window-policy-installed");
    window.once("ready-to-show", () => {
      setStartupStage("window-ready");
      if (showWhenReady || pendingFocus) focusWindow();
    });
    return window;
  };
  const recoverHiddenRoot = (): void => {
    if (quitting || (mainWindow && !mainWindow.isDestroyed())) return;
    const window = createWindow(false);
    diagnostic = "Страница закрыла renderer; создано скрытое окно диагностики. Получение событий страницей приостановлено до «Повторить загрузку»";
    // Never reload a self-closing page automatically: the replacement has no scripts or native bridge.
    void showErrorPage(window);
  };
  const recoverRoot = createHiddenRecoveryScheduler({
    hasWindow: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
    isQuitting: () => quitting,
    schedule: (callback) => { setImmediate(callback); },
    recoverHidden: () => {
      try { recoverHiddenRoot(); }
      catch { diagnostic = "Не удалось восстановить скрытое окно; выберите «Открыть» или «Повторить загрузку»"; }
    },
  });
  restoreMissingWindow = () => {
    try { recoverHiddenRoot(); }
    catch { diagnostic = "Не удалось восстановить окно; повторите действие через меню приложения"; return; }
    if (mainWindow && !mainWindow.isDestroyed()) focusWindow();
  };
  createWindow(true);
  const loadTarget = () => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow(true);
    diagnostic = config.spike ? "Локальный сценарий D1; реальные сообщения не подключены" : "HTTPS оболочка; системный вход поддержан, IdP/deployment не проверены";
    void window.loadURL(config.appURL).catch((error: unknown) => {
      if (isAbortedNavigation(error)) return;
      const code = typeof error === "object" && error !== null && "errno" in error
        && typeof error.errno === "number" && Number.isSafeInteger(error.errno)
        && error.errno >= -100_000 && error.errno <= 0 ? error.errno : "unknown";
      console.error(`Desktop page load failed code=${code}`);
      return showErrorPage(window);
    });
  };
  if (!config.spike) {
    desktopAuth = new DesktopAuthService({
      appURL: config.appURL, platform: os, enabled: true,
      createAttempt: () => {
        let releaseBarrier: (() => void) | undefined;
        return createElectronAuthAttempt(config.appURL, ses, undefined, {
          async prepare() {
            if (!cookieBarrier) throw new AuthFailure("session-install-failed");
            releaseBarrier = cookieBarrier.begin();
            const window = mainWindow;
            if (!window || window.isDestroyed()) throw new AuthFailure("session-install-failed");
            rendererReady = false;
            service.setReady(false);
            window.webContents.stop();
            // Quiesce the previous account's DOM before touching cookies. Late old/SW responses
            // retain their blocked request generation even after the new root is loaded.
            await new Promise<void>((resolve, reject) => {
              let pending = true;
              const timer = setTimeout(() => {
                pending = false;
                if (!window.isDestroyed()) window.webContents.stop();
                reject(new AuthFailure("session-install-failed"));
              }, 10_000);
              timer.unref();
              void ses.closeAllConnections().then(() => {
                if (!pending || quitting || window !== mainWindow || window.isDestroyed()) throw new AuthFailure("session-install-failed");
                return window.loadURL(ERROR_URL);
              }).then(() => {
                pending = false; clearTimeout(timer); resolve();
              }, () => {
                pending = false; clearTimeout(timer); reject(new AuthFailure("session-install-failed"));
              });
            });
          },
          finish() { releaseBarrier?.(); releaseBarrier = undefined; },
        });
      },
      openBrowser: (url) => shell.openExternal(url),
      emit: (state) => handleAuthState(config, state),
      onCommitFailure: loadTarget,
      onSuccess: () => {
        try { service.setAccount(null); if (badge) app.setBadgeCount(0); }
        catch { diagnostic = "Вход завершён; не удалось очистить локальные уведомления предыдущего аккаунта"; }
        loadTarget();
      },
    });
  }
  setStartupStage("installing-menus");
  installMenus(config, service, loadTarget);
  powerMonitor.on("resume", () => {
    emit(config, { type: "window-state", state: windowState() });
    emit(config, { type: "resume" });
  });
  app.on("activate", focusWindow);
  setStartupStage("loading-target");
  loadTarget();
  setStartupStage("load-requested");
  if (pendingFocus) focusWindow();
}
