import { Notification, type NotificationConstructorOptions } from "electron";
import type { Platform } from "./contract";
import { parseWindowsActivation, windowsToastXml, type NativeCallbacks, type NotificationNativePort } from "./notifications";

type ElectronNotificationHandle = {
  readonly id: string;
  on(event: "click" | "failed", callback: () => void): unknown;
  show(): void;
  close(): void;
};
export type ElectronNotificationApi = {
  new(options: NotificationConstructorOptions): ElectronNotificationHandle;
  isSupported(): boolean;
  handleActivation(callback: (details: unknown) => void): void;
  getHistory(): Promise<ElectronNotificationHandle[]>;
  remove(id: string): void;
};

export function createElectronNotificationPort(
  platform: Platform, api: ElectronNotificationApi = Notification, authorized: () => boolean = () => false,
): NotificationNativePort {
  const history = new Map<string, ElectronNotificationHandle>();
  let active = true;
  const bind = (notification: ElectronNotificationHandle, callbacks: NativeCallbacks): void => {
    // v45.2.3's warm WinRT click calls the instance only. COM activation calls
    // central + instance; both converge on the service's once-only entry gate.
    notification.on("click", callbacks.click);
    notification.on("failed", callbacks.failed);
    // A Windows timeout may only move the toast into Action Center; it is not expiry.
  };
  return {
    // isSupported itself constructs Electron's macOS presenter and requests authorization.
    // Capability means the API exists; permission is a separate, fail-closed gate.
    supported: () => platform === "darwin" ? true : api.isSupported(),
    canShow: () => platform !== "darwin" || authorized(),
    create: (options, callbacks) => {
      if (platform === "darwin" && !authorized()) throw new Error("Notification permission unavailable");
      const notification = new api({
        id: options.osId, groupId: options.groupId,
        title: options.title, body: options.body, silent: options.silent,
        ...(platform === "win32" ? { toastXml: windowsToastXml(options) } : {}),
      });
      bind(notification, callbacks);
      return {
        show: () => { if (platform !== "darwin" || authorized()) notification.show(); },
        close: () => { if (platform !== "darwin" || authorized()) notification.close(); },
      };
    },
    subscribeActivation: (activate) => {
      if (platform === "win32") {
        api.handleActivation((details) => {
          const osId = parseWindowsActivation(details);
          if (active && osId !== undefined) activate(osId);
        });
      }
      // Electron has no unregister API. Also stop late macOS history work so
      // a Quit during getHistory() cannot remove the delivered notifications.
      return () => { active = false; };
    },
    restore: async (callbacks) => {
      if (platform !== "darwin" || !authorized() || !active) return;
      const delivered = await api.getHistory();
      for (const notification of delivered) {
        if (!active || !authorized()) return;
        const handlers = callbacks(notification.id);
        if (!handlers) {
          api.remove(notification.id);
          continue;
        }
        if (!history.has(notification.id)) {
          bind(notification, handlers);
          history.set(notification.id, notification);
        }
      }
    },
    remove: (osId) => {
      history.delete(osId);
      if (platform === "darwin" && authorized()) api.remove(osId);
      // Windows close() removes live toasts. There is no public Windows history
      // remove-by-ID API for a toast whose object was lost on process restart.
    },
  };
}
