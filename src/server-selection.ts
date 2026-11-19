import { BrowserWindow, ipcMain, nativeTheme, session, type IpcMainEvent } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseProxySettings } from "./proxy-settings";
import { proxyOnlyDocument, serverSelectionContentSecurityPolicy, serverSelectionDocument, type ProxyFormState } from "./server-selection-document";
import { validateAppURL } from "./security";

const choiceChannel = "chat:server-selection-choice";
const proxyChannel = "chat:server-selection-proxy";
const loadTimeoutMs = 15_000;

type DialogLifecycle = { parent?: BrowserWindow; signal: AbortSignal };
type ProxyOptions = ProxyFormState & { save(value: unknown): void };
type ServerOptions = DialogLifecycle & { initialURL: string; switching: boolean; proxy?: ProxyOptions };
type DialogOptions = DialogLifecycle & ({ server: { initialURL: string; switching: boolean }; proxy?: ProxyOptions }
  | { server?: undefined; proxy: ProxyOptions });

export function selectServer({ parent, signal, initialURL, switching, proxy }: ServerOptions): Promise<string | null> {
  return openDialog({ parent, signal, server: { initialURL, switching }, proxy }).then((result) => typeof result === "string" ? result : null);
}

export function configureProxy({ parent, signal, ...proxy }: DialogLifecycle & ProxyOptions): Promise<boolean> {
  return openDialog({ parent, signal, proxy }).then((result) => result === true);
}

function openDialog({ parent, signal, server, proxy }: DialogOptions): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    let child: BrowserWindow | undefined;
    let settled = false;
    let shown = false;
    const cleanup: (() => void)[] = [];
    const available = () => !signal.aborted && (!parent || (!parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()));
    const finish = (result: string | boolean | null) => {
      if (settled) return;
      settled = true;
      // No live document may outlast its restrictive ephemeral session policy.
      try { if (child && !child.isDestroyed()) child.destroy(); } catch { /* The renderer may already be gone. */ }
      for (const remove of cleanup.splice(0)) {
        try { remove(); } catch { /* Finish all cleanup even after Electron object destruction. */ }
      }
      resolve(result);
    };
    const cancel = () => finish(null);
    const watchCancellation = (target: NodeJS.EventEmitter, event: string) => {
      target.on(event, cancel);
      cleanup.push(() => target.removeListener(event, cancel));
    };
    try {
      if (!available()) { cancel(); return; }
      const token = randomBytes(32).toString("hex");
      const documentId = randomBytes(32).toString("hex");
      const html = server ? serverSelectionDocument(server.initialURL, server.switching, proxy) : proxyOnlyDocument(proxy);
      const documentURL = `chat-server-selection://dialog/${documentId}`;
      let expectedContentsId: number | undefined;
      let initialRequest = true;
      const isolatedSession = session.fromPartition(`chat-server-selection-${documentId}`, { cache: false });
      cleanup.push(() => isolatedSession.protocol.unhandle("chat-server-selection"));
      cleanup.push(() => isolatedSession.webRequest.onBeforeRequest(null));
      cleanup.push(() => isolatedSession.setPermissionCheckHandler(null));
      cleanup.push(() => isolatedSession.setPermissionRequestHandler(null));
      cleanup.push(() => isolatedSession.setDevicePermissionHandler(null));
      cleanup.push(() => isolatedSession.setDisplayMediaRequestHandler(null));
      cleanup.push(() => { void isolatedSession.closeAllConnections().catch(() => {}); });
      cleanup.push(() => { void isolatedSession.clearStorageData().catch(() => {}); });
      isolatedSession.protocol.handle("chat-server-selection", (request) => new Response(
        request.url === documentURL && request.method === "GET" ? html : null,
        { status: request.url === documentURL && request.method === "GET" ? 200 : 403,
          headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": serverSelectionContentSecurityPolicy,
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } },
      ));
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolatedSession.setDevicePermissionHandler(() => false);
      isolatedSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));
      isolatedSession.webRequest.onBeforeRequest((details, callback) => {
        const localDocument = initialRequest && expectedContentsId !== undefined && details.webContentsId === expectedContentsId
          && details.method === "GET" && details.resourceType === "mainFrame" && details.url === documentURL;
        if (localDocument) initialRequest = false;
        callback({ cancel: !localDocument });
      });
      const denyDownload = (event: Electron.Event) => event.preventDefault();
      isolatedSession.on("will-download", denyDownload);
      cleanup.push(() => isolatedSession.removeListener("will-download", denyDownload));
      const window = new BrowserWindow({
        ...(parent ? { parent } : {}), modal: parent !== undefined, frame: false, show: false, transparent: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#23262f" : "#ffffff",
        width: 540, height: proxy ? 560 : 460, useContentSize: true, resizable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: parent !== undefined, autoHideMenuBar: true, thickFrame: false,
        title: server ? "Сервер Чата" : "Настройки прокси", icon: join(__dirname, "app-icon.png"),
        webPreferences: {
          session: isolatedSession, preload: join(__dirname, "server-selection-preload.cjs"),
          additionalArguments: [`--chat-server-selection-token=${token}`, `--chat-server-selection-document=${documentId}`],
          contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true,
          webSecurity: true, webviewTag: false, navigateOnDragDrop: false, devTools: false, spellcheck: false,
        },
      });
      child = window;
      window.setMenu(null);
      const contents = window.webContents;
      expectedContentsId = contents.id;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      if (parent) for (const event of ["close", "closed", "hide", "minimize"]) watchCancellation(parent, event);
      for (const event of ["close", "closed", "hide", "unresponsive"]) watchCancellation(window, event);
      for (const event of ["destroyed", "did-fail-load", "render-process-gone", "preload-error", "did-navigate-in-page"]) watchCancellation(contents, event);
      signal.addEventListener("abort", cancel, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", cancel));
      const exactDocument = () => !window.isDestroyed() && !contents.isDestroyed()
        && !contents.mainFrame.isDestroyed() && contents.mainFrame.parent === null
        && contents.mainFrame.url === documentURL && contents.getURL() === documentURL;
      const fromDialog = (event: IpcMainEvent, args: unknown[]) => !settled && shown && args.length === 2 && args[0] === token
        && event.sender === contents && event.senderFrame === contents.mainFrame && exactDocument();
      const answer = (event: IpcMainEvent, ...args: unknown[]) => {
        try {
          if (!fromDialog(event, args) || (args[1] !== null && typeof args[1] !== "string")) return;
          if (!available() || args[1] === null) { cancel(); return; }
          let canonicalURL: string;
          try { canonicalURL = validateAppURL(args[1]); }
          catch {
            contents.send("chat:server-selection-error", token, "Укажите HTTPS-адрес сервера без пути, параметров и данных входа.");
            return;
          }
          finish(canonicalURL);
        } catch { cancel(); }
      };
      if (server) {
        ipcMain.on(choiceChannel, answer);
        cleanup.push(() => ipcMain.removeListener(choiceChannel, answer));
      }
      if (proxy) {
        let current = proxy.current;
        let needsReset = proxy.needsReset;
        const setProxy = (event: IpcMainEvent, ...args: unknown[]) => {
          try {
            if (!fromDialog(event, args)) return;
            if (!available()) { cancel(); return; }
            if (args[1] === null) { if (!server) cancel(); return; }
            let changed = false;
            try {
              const value = parseProxySettings(args[1]);
              changed = Boolean(needsReset) || value.mode !== current.mode || value.scope !== current.scope
                || ("host" in value && (!("host" in current) || value.host !== current.host || value.port !== current.port));
              if (changed) {
                proxy.save(value);
                current = value;
                needsReset = false;
              }
            } catch {
              contents.send("chat:server-selection-proxy-result", token, false);
              return;
            }
            if (server) contents.send("chat:server-selection-proxy-result", token, true);
            else finish(changed);
          } catch { cancel(); }
        };
        ipcMain.on(proxyChannel, setProxy);
        cleanup.push(() => ipcMain.removeListener(proxyChannel, setProxy));
      }
      const preventNavigation = (event: Electron.Event) => { event.preventDefault(); cancel(); };
      contents.on("will-navigate", preventNavigation);
      contents.on("will-frame-navigate", preventNavigation);
      contents.on("will-redirect", preventNavigation);
      cleanup.push(() => contents.removeListener("will-navigate", preventNavigation));
      cleanup.push(() => contents.removeListener("will-frame-navigate", preventNavigation));
      cleanup.push(() => contents.removeListener("will-redirect", preventNavigation));
      let initialNavigation = true;
      const navigationStarted = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
        if (initialNavigation && event.isMainFrame && !event.isSameDocument && event.url === documentURL) {
          initialNavigation = false;
          return;
        }
        cancel();
      };
      contents.on("did-start-navigation", navigationStarted);
      cleanup.push(() => contents.removeListener("did-start-navigation", navigationStarted));
      const keyboard = (event: Electron.Event, input: Electron.Input) => {
        // The preload handles Escape in the inline flow so it can return to the server panel.
        if (input.type === "keyDown" && ((!(server && proxy) && input.key === "Escape")
            || ((input.control || input.meta) && input.key.toLowerCase() === "w"))) {
          event.preventDefault(); cancel();
        }
      };
      contents.on("before-input-event", keyboard);
      cleanup.push(() => contents.removeListener("before-input-event", keyboard));
      const timeout = setTimeout(cancel, loadTimeoutMs);
      cleanup.push(() => clearTimeout(timeout));
      const ready = () => {
        try {
          if (settled) return;
          if (!available() || !exactDocument()) { cancel(); return; }
          clearTimeout(timeout);
          shown = true;
          window.show();
          window.focus();
        } catch { cancel(); }
      };
      window.once("ready-to-show", ready);
      cleanup.push(() => window.removeListener("ready-to-show", ready));
      if (!available()) { cancel(); return; }
      void window.loadURL(documentURL).catch(cancel);
    } catch { cancel(); }
  });
}
