export const BRIDGE_VERSION = 1;
export const APP_ID = "ru.exz-vps.chat.desktop.spike";
export const IPC = {
  capabilities: "chat-desktop:v1:capabilities",
  getAuthState: "chat-desktop:v1:get-auth-state",
  beginLogin: "chat-desktop:v1:begin-login",
  cancelLogin: "chat-desktop:v1:cancel-login",
  setAccount: "chat-desktop:v1:set-account",
  showNotification: "chat-desktop:v1:show-notification",
  closeNotification: "chat-desktop:v1:close-notification",
  clearNotifications: "chat-desktop:v1:clear-notifications",
  dismissNotifications: "chat-desktop:v1:dismiss-notifications",
  setBadge: "chat-desktop:v1:set-badge",
  ready: "chat-desktop:v1:ready",
  event: "chat-desktop:v1:event",
} as const;

export type Platform = "darwin" | "win32" | "linux";
export type NotificationKind = "message" | "call" | "test";
export type NotificationRoute = {
  chatId: string;
  callId?: string;
};
export type NotificationRequest = {
  id: string;
  accountId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  route: NotificationRoute;
  silent: boolean;
  expiresAt: number;
};
export type NotificationKey = { id: string; accountId: string };
export type NotificationDismissal =
  | { accountId: string; kind: "message"; chatId: string; throughMessageId: number }
  | { accountId: string; kind: "call"; callId: string }
  | { accountId: string; kind: "call"; exceptCallIds: readonly string[] };
export type DesktopAuthErrorCode = "unsupported-server" | "unavailable" | "network" | "invalid-response" | "auth-failed" | "session-install-failed";
export type DesktopLoginRequest = { door: string };
export type DesktopAuthState =
  | { status: "idle" | "starting" | "committing" | "success" | "cancelled" | "denied" | "expired" }
  | { status: "waiting"; userCode: string; expiresAt: number }
  | { status: "error"; code: DesktopAuthErrorCode };
export type WindowState = { focused: boolean; visible: boolean; minimized: boolean };
export type DesktopEvent =
  | { type: "auth-state"; state: DesktopAuthState }
  | { type: "activation"; id: string; accountId: string; route: NotificationRoute }
  | { type: "window-state"; state: WindowState }
  | { type: "resume" }
  | { type: "notification-error"; id: string; code: "unsupported" | "failed" };
export type DesktopCapabilities = {
  version: typeof BRIDGE_VERSION;
  platform: Platform;
  notifications: boolean;
  notificationPermission: "unknown";
  badge: boolean;
  lifecycle: true;
  productionAuth: boolean;
};
export type NotificationResult = { accepted: boolean; reason?: "unsupported" | "expired" | "account-mismatch" | "limit" | "duplicate" | "failed" };

export type DesktopBridge = {
  version: typeof BRIDGE_VERSION;
  getCapabilities(): Promise<DesktopCapabilities>;
  getAuthState(): Promise<DesktopAuthState>;
  beginLogin(request: DesktopLoginRequest): Promise<DesktopAuthState>;
  cancelLogin(): Promise<void>;
  setAccount(accountId: string | null): Promise<void>;
  showNotification(request: NotificationRequest): Promise<NotificationResult>;
  closeNotification(key: NotificationKey): Promise<void>;
  clearNotifications(): Promise<void>;
  dismissNotifications?(selector: NotificationDismissal): Promise<void>;
  setBadge(count: number): Promise<void>;
  ready(): Promise<void>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isRoute(value: unknown): value is NotificationRoute {
  return isRecord(value) && onlyKeys(value, ["chatId", "callId"]) && isIdentifier(value.chatId)
    && (value.callId === undefined || isIdentifier(value.callId));
}

export function isNotificationRequest(value: unknown): value is NotificationRequest {
  if (!isRecord(value) || !onlyKeys(value, ["id", "accountId", "kind", "title", "body", "route", "silent", "expiresAt"])) return false;
  return isIdentifier(value.id) && isIdentifier(value.accountId)
    && (value.kind === "message" || value.kind === "call" || value.kind === "test")
    && typeof value.title === "string" && value.title.length > 0 && value.title.length <= 256
    && typeof value.body === "string" && value.body.length <= 2048
    && isRoute(value.route) && typeof value.silent === "boolean"
    && typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
}

export function isNotificationKey(value: unknown): value is NotificationKey {
  return isRecord(value) && onlyKeys(value, ["id", "accountId"]) && isIdentifier(value.id) && isIdentifier(value.accountId);
}

export function isNotificationDismissal(value: unknown): value is NotificationDismissal {
  if (!isRecord(value) || !isIdentifier(value.accountId)) return false;
  if (value.kind === "message") {
    return Object.keys(value).length === 4 && onlyKeys(value, ["accountId", "kind", "chatId", "throughMessageId"])
      && isIdentifier(value.chatId) && typeof value.throughMessageId === "number"
      && Number.isSafeInteger(value.throughMessageId) && value.throughMessageId >= 0;
  }
  if (value.kind !== "call" || Object.keys(value).length !== 3) return false;
  if (onlyKeys(value, ["accountId", "kind", "callId"])) return isIdentifier(value.callId);
  if (!onlyKeys(value, ["accountId", "kind", "exceptCallIds"]) || !Array.isArray(value.exceptCallIds)
    || value.exceptCallIds.length > 100) return false;
  const ids = new Set<string>();
  for (const id of value.exceptCallIds) {
    if (!isIdentifier(id) || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

export function isAuthDoor(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{0,64}$/.test(value);
}

export function isLoginRequest(value: unknown): value is DesktopLoginRequest {
  return isRecord(value) && Object.keys(value).length === 1 && onlyKeys(value, ["door"]) && isAuthDoor(value.door);
}

export function isAuthState(value: unknown): value is DesktopAuthState {
  if (!isRecord(value)) return false;
  if (value.status === "waiting") return Object.keys(value).length === 3 && onlyKeys(value, ["status", "userCode", "expiresAt"])
    && typeof value.userCode === "string" && /^[23456789BCDFGHJKMNPQ]{4}-[23456789BCDFGHJKMNPQ]{4}$/.test(value.userCode)
    && typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
  if (value.status === "error") return Object.keys(value).length === 2 && onlyKeys(value, ["status", "code"])
    && (value.code === "unsupported-server" || value.code === "unavailable" || value.code === "network"
      || value.code === "invalid-response" || value.code === "auth-failed" || value.code === "session-install-failed");
  return Object.keys(value).length === 1 && onlyKeys(value, ["status"]) && (value.status === "idle" || value.status === "starting"
    || value.status === "committing" || value.status === "success" || value.status === "cancelled"
    || value.status === "denied" || value.status === "expired");
}

export function isBadgeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 999999;
}
