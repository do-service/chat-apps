import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_VERSION, IPC, isAuthState, isBadgeCount, isIdentifier, isLoginRequest, isNotificationDismissal, isNotificationKey, isNotificationRequest,
  type DesktopBridge,
} from "./contract";
import {
  isCapabilities, isDesktopEvent, isNotificationResult, isTrustedURL, trustedOriginFromArguments,
} from "./security";

const trustedOrigin = trustedOriginFromArguments(process.argv);

// The preload is bundled into one CJS file because a sandboxed preload cannot require local modules.
if (process.isMainFrame && window.top === window && trustedOrigin
    && window.location.origin === trustedOrigin && isTrustedURL(window.location.href, trustedOrigin)) {
  let subscriptions = 0;
  const bridge: DesktopBridge = {
    version: BRIDGE_VERSION,
    async getCapabilities() {
      const result: unknown = await ipcRenderer.invoke(IPC.capabilities);
      if (!isCapabilities(result)) throw new Error("Invalid desktop capabilities");
      return result;
    },
    async getAuthState() {
      const result: unknown = await ipcRenderer.invoke(IPC.getAuthState);
      if (!isAuthState(result)) throw new Error("Invalid desktop auth state");
      return result;
    },
    async beginLogin(request) {
      if (!isLoginRequest(request)) throw new Error("Invalid desktop login request");
      const result: unknown = await ipcRenderer.invoke(IPC.beginLogin, request);
      if (!isAuthState(result)) throw new Error("Invalid desktop auth state");
      return result;
    },
    async cancelLogin() { await ipcRenderer.invoke(IPC.cancelLogin); },
    async setAccount(accountId) {
      if (accountId !== null && !isIdentifier(accountId)) throw new Error("Invalid account identifier");
      await ipcRenderer.invoke(IPC.setAccount, accountId);
    },
    async showNotification(request) {
      if (!isNotificationRequest(request)) throw new Error("Invalid notification");
      const result: unknown = await ipcRenderer.invoke(IPC.showNotification, request);
      if (!isNotificationResult(result)) throw new Error("Invalid notification result");
      return result;
    },
    async closeNotification(key) {
      if (!isNotificationKey(key)) throw new Error("Invalid notification key");
      await ipcRenderer.invoke(IPC.closeNotification, key);
    },
    async clearNotifications() { await ipcRenderer.invoke(IPC.clearNotifications); },
    async dismissNotifications(selector) {
      if (!isNotificationDismissal(selector)) throw new Error("Invalid notification dismissal");
      await ipcRenderer.invoke(IPC.dismissNotifications, selector);
    },
    async setBadge(count) {
      if (!isBadgeCount(count)) throw new Error("Invalid badge count");
      await ipcRenderer.invoke(IPC.setBadge, count);
    },
    async ready() { await ipcRenderer.invoke(IPC.ready); },
    onEvent(listener) {
      if (typeof listener !== "function" || subscriptions >= 32) throw new Error("Invalid desktop subscription");
      const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (isDesktopEvent(value)) listener(value);
      };
      subscriptions += 1;
      ipcRenderer.on(IPC.event, handler);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscriptions -= 1;
        ipcRenderer.removeListener(IPC.event, handler);
      };
    },
  };
  contextBridge.exposeInMainWorld("chatDesktop", bridge);
}
