import { join } from "node:path";
import { isNativeNotificationPermission, isRecord, type NativeNotificationPermission, type Platform } from "./contract";

type NativePermissionModule = { getPermission(): unknown; requestPermission(): unknown };
export type NotificationPermissionController = {
  current(): NativeNotificationPermission;
  get(isCurrent?: () => boolean): Promise<NativeNotificationPermission>;
  request(isCurrent: () => boolean, canPrompt?: () => boolean): Promise<NativeNotificationPermission>;
};

function isNativeModule(value: unknown): value is NativePermissionModule {
  return isRecord(value) && typeof value.getPermission === "function" && typeof value.requestPermission === "function";
}

function loadNative(): unknown {
  // This is loaded only by the main process, from one fixed ASAR-unpacked build artifact.
  const loaded: unknown = require(join(__dirname, "notification-permission.node"));
  return loaded;
}

export function coordinateNotificationPermissionController(
  controller: NotificationPermissionController, isAlive: () => boolean,
): NotificationPermissionController {
  let queue = Promise.resolve();
  let reading: Promise<NativeNotificationPermission> | undefined;
  const enqueue = (operation: () => Promise<NativeNotificationPermission>): Promise<NativeNotificationPermission> => {
    const result = queue.then(() => isAlive() ? operation() : "unknown").catch((): NativeNotificationPermission => "unknown");
    queue = result.then(() => {});
    return result;
  };
  return {
    current: () => isAlive() ? controller.current() : "unknown",
    async get(isCurrent = () => true) {
      if (!isAlive() || !isCurrent()) return "unknown";
      if (!reading) {
        // One document leaving must not invalidate another consumer's shared OS read.
        const pending = enqueue(() => controller.get(isAlive));
        reading = pending;
        void pending.then(() => { if (reading === pending) reading = undefined; });
      }
      const result = await reading;
      return isAlive() && isCurrent() ? result : "unknown";
    },
    async request(isCurrent, canPrompt = isCurrent) {
      if (!isAlive() || !isCurrent()) return "unknown";
      // Later reads must wait for the entire prompt transaction, including its final OS reread.
      reading = undefined;
      const current = () => isAlive() && isCurrent();
      const result = await enqueue(() => controller.request(current, () => current() && canPrompt()));
      return current() ? result : "unknown";
    },
  };
}

export function createNotificationPermissionController(
  platform: Platform, load: () => unknown = loadNative, timeoutMs = 35_000,
): NotificationPermissionController {
  let status: NativeNotificationPermission = "unknown";
  let native: NativePermissionModule | undefined;
  let loaded = false;
  let revision = 0;
  let requesting: Promise<NativeNotificationPermission> | undefined;
  const module = (): NativePermissionModule | undefined => {
    if (platform !== "darwin") return undefined;
    if (!loaded) {
      loaded = true;
      try { const value = load(); if (isNativeModule(value)) native = value; } catch { /* Unavailable is never granted. */ }
    }
    return native;
  };
  const run = async (operation: () => unknown): Promise<NativeNotificationPermission> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result: unknown = await Promise.race([
        Promise.resolve().then(operation),
        new Promise<"unknown">((resolve) => { timer = setTimeout(() => resolve("unknown"), timeoutMs); }),
      ]);
      return isNativeNotificationPermission(result) ? result : "unknown";
    } catch { return "unknown"; }
    finally { if (timer) clearTimeout(timer); }
  };
  const get = async (isCurrent = () => true): Promise<NativeNotificationPermission> => {
    const version = ++revision;
    const api = module();
    const result = api ? await run(() => api.getPermission()) : "unknown";
    if (version === revision) status = isCurrent() ? result : "unknown";
    if (!isCurrent()) return "unknown";
    return version === revision ? result : "unknown";
  };
  return {
    current: () => status,
    get,
    async request(isCurrent, canPrompt = isCurrent) {
      if (!isCurrent()) return "unknown";
      if (!requesting) {
        requesting = (async (): Promise<NativeNotificationPermission> => {
          const before = await get(isCurrent);
          if (!isCurrent()) return "unknown";
          if (before !== "not-determined") return before;
          const api = module();
          if (!api || !canPrompt()) return "unknown";
          const version = ++revision;
          // No microtask may separate the final document guard from the native invocation.
          let result: unknown;
          try { if (!isCurrent() || !canPrompt()) return "unknown"; result = api.requestPermission(); }
          catch { result = "unknown"; }
          const permission = await run(() => result);
          if (version === revision) status = isCurrent() ? permission : "unknown";
          if (!isCurrent() || permission === "unknown") return "unknown";
          // Read actual OS settings again: the completion boolean is not permission status.
          return get(isCurrent);
        })().finally(() => { requesting = undefined; });
      }
      const result = await requesting;
      return isCurrent() ? result : "unknown";
    },
  };
}
