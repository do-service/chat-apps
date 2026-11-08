import {
  BRIDGE_VERSION, isAuthDoor, isAuthState, isIdentifier, isRecord, isRoute,
  type DesktopCapabilities, type DesktopEvent, type NotificationResult,
} from "./contract";

export const SPIKE_ORIGIN = "chat-spike://app";
export const SPIKE_URL = `${SPIKE_ORIGIN}/`;
export const ERROR_ORIGIN = "chat-desktop-error://app";
export const ERROR_URL = `${ERROR_ORIGIN}/`;
export const TRUSTED_ORIGIN_ARGUMENT = "--chat-desktop-trusted-origin=";

function parseURL(value: string): URL | null {
  if (value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  try { return new URL(value); } catch { return null; }
}

export function validateAppURL(value: unknown): string {
  if (typeof value !== "string" || !/^https:\/\/[^/?#]+\/?$/i.test(value)) {
    throw new Error("DESKTOP_APP_URL must be an explicit HTTPS origin root");
  }
  const url = parseURL(value);
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("DESKTOP_APP_URL must be an explicit HTTPS origin root");
  }
  return `${url.origin}/`;
}

export function isTrustedURL(value: string, trustedOrigin: string): boolean {
  const url = parseURL(value);
  if (!url || url.username || url.password) return false;
  if (trustedOrigin === SPIKE_ORIGIN) {
    return url.protocol === "chat-spike:" && url.host === "app" && !url.port
      && url.pathname === "/" && !url.search;
  }
  return url.protocol === "https:" && url.origin === trustedOrigin;
}

export function isAllowedFrameNavigation(value: string, trustedOrigin: string, isMainFrame: boolean): boolean {
  // The fixed local error document is a navigation destination, never a trusted bridge origin.
  return (isMainFrame && value === ERROR_URL) || isTrustedURL(value, trustedOrigin);
}

export function trustedOriginFromArguments(args: string[]): string | null {
  const values = args.filter((arg) => arg.startsWith(TRUSTED_ORIGIN_ARGUMENT));
  if (values.length !== 1) return null;
  const value = values[0]?.slice(TRUSTED_ORIGIN_ARGUMENT.length);
  if (value === SPIKE_ORIGIN) return value;
  try {
    const url = validateAppURL(value);
    return new URL(url).origin;
  } catch { return null; }
}

export type SenderDetails = {
  expectedContents: boolean;
  mainFrame: boolean;
  frameOrigin: string;
  frameURL: string;
};

export function isTrustedSender(details: SenderDetails, trustedOrigin: string): boolean {
  return details.expectedContents && details.mainFrame && details.frameOrigin === trustedOrigin
    && isTrustedURL(details.frameURL, trustedOrigin);
}

export function loginNavigationDoor(value: string, trustedOrigin: string, isMainFrame: boolean): string | null {
  if (!isMainFrame || !isTrustedURL(value, trustedOrigin)) return null;
  const url = parseURL(value);
  if (!url || url.search || url.hash) return null;
  const match = /^\/auth\/login(?:\/([a-zA-Z0-9_-]{1,64}))?$/.exec(url.pathname);
  if (!match) return null;
  const door = match[1] ?? "";
  return isAuthDoor(door) ? door : null;
}

export function externalHTTPSURL(value: string, trustedOrigin: string): string | null {
  const url = parseURL(value);
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password
      || url.origin === trustedOrigin) return null;
  return url.href;
}

// A fixed resource map, not path resolution: no user-controlled file path reaches the filesystem.
export function spikeResource(value: string): { file: string; contentType: string } | null {
  switch (value) {
    case `${SPIKE_ORIGIN}/`: return { file: "index.html", contentType: "text/html; charset=utf-8" };
    case `${SPIKE_ORIGIN}/spike.js`: return { file: "spike.js", contentType: "text/javascript; charset=utf-8" };
    case `${SPIKE_ORIGIN}/spike.css`: return { file: "spike.css", contentType: "text/css; charset=utf-8" };
    default: return null;
  }
}

export function isDesktopEvent(value: unknown): value is DesktopEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "auth-state": return Object.keys(value).length === 2 && isAuthState(value.state);
    case "activation": return isIdentifier(value.id) && isIdentifier(value.accountId) && isRoute(value.route);
    case "window-state": return isRecord(value.state) && typeof value.state.focused === "boolean"
      && typeof value.state.visible === "boolean" && typeof value.state.minimized === "boolean";
    case "resume": return true;
    case "notification-error": return isIdentifier(value.id) && (value.code === "unsupported" || value.code === "failed");
    default: return false;
  }
}

export function isCapabilities(value: unknown): value is DesktopCapabilities {
  return isRecord(value) && value.version === BRIDGE_VERSION
    && (value.platform === "darwin" || value.platform === "win32" || value.platform === "linux")
    && typeof value.notifications === "boolean" && value.notificationPermission === "unknown"
    && typeof value.badge === "boolean" && value.lifecycle === true && typeof value.productionAuth === "boolean";
}

export function isNotificationResult(value: unknown): value is NotificationResult {
  return isRecord(value) && typeof value.accepted === "boolean"
    && (value.reason === undefined || value.reason === "unsupported" || value.reason === "expired"
      || value.reason === "account-mismatch" || value.reason === "limit" || value.reason === "duplicate" || value.reason === "failed");
}
