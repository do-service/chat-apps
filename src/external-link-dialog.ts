import { BrowserWindow, ipcMain, nativeTheme, session, type IpcMainEvent } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { externalLinkContentSecurityPolicy, externalLinkDocument } from "./external-link-document";

const choiceChannel = "chat:external-link-choice";
const loadTimeoutMs = 15_000;

export function confirmExternalLink(options: { parent: BrowserWindow; url: string; signal: AbortSignal }): Promise<boolean> {
  const { parent, url, signal } = options;
  return new Promise((resolve) => {
    let child: BrowserWindow | undefined;
    let settled = false;
    let shown = false;
    const cleanup: (() => void)[] = [];
    const parentAvailable = () => !signal.aborted && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized();
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      // Destroy before releasing session policy, so no document survives with defaults.
      try { if (child && !child.isDestroyed()) child.destroy(); } catch { /* The renderer may already be gone. */ }
      for (const remove of cleanup.splice(0)) {
        try { remove(); } catch { /* Finish every cleanup even if one Electron object is gone. */ }
      }
      resolve(confirmed);
    };
    const cancel = () => finish(false);
    const watchCancellation = (target: NodeJS.EventEmitter, event: string) => {
      target.on(event, cancel);
      cleanup.push(() => target.removeListener(event, cancel));
    };
    try {
      if (!parentAvailable()) { cancel(); return; }
      const destination = new URL(url);
      if (destination.protocol !== "https:" || destination.username || destination.password) { cancel(); return; }
      const token = randomBytes(32).toString("hex");
      const documentId = randomBytes(32).toString("hex");
      const html = externalLinkDocument(url);
      // A URL-free local address keeps Chromium's automatic load warnings free of the external URL.
      const documentURL = `chat-external-link://dialog/${documentId}`;
      let expectedContentsId: number | undefined;
      let initialRequest = true;
      const isolatedSession = session.fromPartition(`chat-external-link-${documentId}`, { cache: false });
      cleanup.push(() => isolatedSession.protocol.unhandle("chat-external-link"));
      cleanup.push(() => isolatedSession.webRequest.onBeforeRequest(null));
      cleanup.push(() => isolatedSession.setPermissionCheckHandler(null));
      cleanup.push(() => isolatedSession.setPermissionRequestHandler(null));
      cleanup.push(() => isolatedSession.setDevicePermissionHandler(null));
      cleanup.push(() => isolatedSession.setDisplayMediaRequestHandler(null));
      cleanup.push(() => { void isolatedSession.closeAllConnections().catch(() => {}); });
      cleanup.push(() => { void isolatedSession.clearStorageData().catch(() => {}); });
      isolatedSession.protocol.handle("chat-external-link", (request) => new Response(
        request.url === documentURL && request.method === "GET" ? html : null,
        {
          status: request.url === documentURL && request.method === "GET" ? 200 : 403,
          headers: {
            "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": externalLinkContentSecurityPolicy,
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
          },
        },
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
        parent, modal: true, frame: false, show: false, transparent: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#23262f" : "#ffffff",
        width: 500, height: 460, useContentSize: true, resizable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, autoHideMenuBar: true, thickFrame: false,
        title: "Открыть в браузере?",
        webPreferences: {
          session: isolatedSession, preload: join(__dirname, "external-link-preload.cjs"),
          additionalArguments: [`--chat-external-link-token=${token}`, `--chat-external-link-document=${documentId}`],
          contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true,
          webSecurity: true, webviewTag: false, navigateOnDragDrop: false, devTools: false, spellcheck: false,
        },
      });
      child = window;
      window.setMenu(null);
      const contents = window.webContents;
      expectedContentsId = contents.id;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      for (const event of ["close", "closed", "hide", "minimize"]) watchCancellation(parent, event);
      for (const event of ["close", "closed", "hide", "unresponsive"]) watchCancellation(window, event);
      for (const event of ["destroyed", "did-fail-load", "render-process-gone", "preload-error", "did-navigate-in-page"]) {
        watchCancellation(contents, event);
      }
      signal.addEventListener("abort", cancel, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", cancel));
      const exactDocument = () => !window.isDestroyed() && !contents.isDestroyed()
        && !contents.mainFrame.isDestroyed() && contents.mainFrame.parent === null
        && contents.mainFrame.url === documentURL && contents.getURL() === documentURL;
      const answer = (event: IpcMainEvent, ...args: unknown[]) => {
        try {
          if (settled || !shown || args.length !== 2 || args[0] !== token || typeof args[1] !== "boolean"
              || event.sender !== contents || event.senderFrame !== contents.mainFrame || !exactDocument()) return;
          finish(parentAvailable() && args[1]);
        } catch { cancel(); }
      };
      ipcMain.on(choiceChannel, answer);
      cleanup.push(() => ipcMain.removeListener(choiceChannel, answer));
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
        if (input.type === "keyDown" && (input.key === "Escape" || ((input.control || input.meta) && input.key.toLowerCase() === "w"))) {
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
          if (!parentAvailable() || !exactDocument()) { cancel(); return; }
          clearTimeout(timeout);
          shown = true;
          window.show();
          window.focus();
        } catch { cancel(); }
      };
      window.once("ready-to-show", ready);
      cleanup.push(() => window.removeListener("ready-to-show", ready));
      if (!parentAvailable()) { cancel(); return; }
      void window.loadURL(documentURL).catch(cancel);
    } catch { cancel(); }
  });
}
