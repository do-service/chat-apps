import { session } from "electron";
import { randomUUID } from "node:crypto";
import { isRecord } from "./contract";
import { AuthFailure, SESSION_COOKIE, validateSessionCookie, type AuthAttemptPort, type AuthCookie, type AuthResponse } from "./desktop-auth";
import { validateAppURL } from "./security";

export type AuthSessionPort = {
  fetch(input: string, init: RequestInit): Promise<Response>;
  cookies: Pick<Electron.Cookies, "get" | "set" | "remove" | "flushStore">;
  closeAllConnections(): Promise<void>;
  clearStorageData(): Promise<void>;
};

export class CookieWriteBarrier {
  private generation = 0;
  private committing = false;
  private readonly requests = new Map<number, { generation: number; allowed: boolean }>();
  start(id: number, owned: boolean): void {
    // Untracked responses fail closed if the bound is reached.
    // Redirects reuse the request ID: never upgrade an old request into a new generation.
    if (!this.requests.has(id) && this.requests.size < 10_000) this.requests.set(id, { generation: this.generation, allowed: owned && !this.committing });
  }
  end(id: number): void { this.requests.delete(id); }
  allows(id: number): boolean {
    const request = this.requests.get(id);
    return Boolean(!this.committing && request && request.generation === this.generation && request.allowed);
  }
  begin(): () => void {
    if (this.committing) throw new AuthFailure("session-install-failed");
    this.committing = true;
    this.generation++;
    let active = true;
    return () => { if (active) { active = false; this.committing = false; } };
  }
  headers(id: number, headers: Record<string, string[]>): Record<string, string[]> {
    if (this.allows(id)) return headers;
    return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "set-cookie"));
  }
}

export function installAuthCookieBarrier(
  jar: Pick<Electron.Session, "webRequest">, rootContentsId: () => number | null,
): CookieWriteBarrier {
  const barrier = new CookieWriteBarrier();
  jar.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const root = rootContentsId();
    barrier.start(details.id, root !== null && details.webContentsId === root);
    callback({ cancel: false });
  });
  jar.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ responseHeaders: barrier.headers(details.id, details.responseHeaders ?? {}) });
  });
  jar.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => barrier.end(details.id));
  jar.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => barrier.end(details.id));
  return barrier;
}

export async function boundedJSON(response: Response, maximum = 4096): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AuthFailure("invalid-response");
  const reader = response.body?.getReader();
  if (!reader) throw new AuthFailure("invalid-response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new AuthFailure("invalid-response"); }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks, length).toString("utf8");
    try { return JSON.parse(body); } catch { throw new AuthFailure("invalid-response"); }
  } finally { reader.releaseLock(); }
}
function matchingCookie(cookies: Electron.Cookie[], expected: AuthCookie): boolean {
  return cookies.length === 1 && cookies[0]?.value === expected.value;
}
function sameSnapshot(first: Electron.Cookie[], second: Electron.Cookie[]): boolean {
  return first.length === second.length && first.length <= 1 && first[0]?.value === second[0]?.value;
}

export function createElectronAuthAttempt(
  appURL: string, persistent: AuthSessionPort,
  ephemeral: AuthSessionPort = session.fromPartition(`chat-auth-${randomUUID()}`, { cache: false }),
  commitHooks?: { prepare(): Promise<void>; finish(): void },
): AuthAttemptPort {
  const root = validateAppURL(appURL);
  const origin = new URL(root).origin;
  const filter = { url: root, name: SESSION_COOKIE };
  // A newer login/logout while the user was in the browser must not be overwritten by this attempt.
  const baseline = persistent.cookies.get(filter).catch(() => undefined);
  let disposed = false;
  const perform = async (jar: AuthSessionPort, path: string, method: "GET" | "POST", body: unknown, signal: AbortSignal) => {
    const response = await jar.fetch(`${origin}${path}`, {
      method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      headers: { Origin: origin, "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include", redirect: "error", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    // Response.url/type are not trustworthy in Electron45 net.fetch; the fixed input and redirect:error are the boundary.
    return response;
  };
  return {
    async prepareCommit() { await commitHooks?.prepare(); },
    async finishCommit() { commitHooks?.finish(); },
    async post(path, body, signal): Promise<AuthResponse> {
      const response = await perform(ephemeral, path, "POST", body, signal);
      if (response.status === 204 || response.status === 404 || response.status >= 500) {
        if (response.body) await response.body.cancel();
        return { status: response.status };
      }
      const retry = response.headers.get("retry-after");
      if (path === "/auth/desktop/ack" && response.status === 429 && retry !== null
          && (!/^\d{1,3}$/.test(retry) || Number(retry) < 2 || Number(retry) > 30)) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new AuthFailure("invalid-response");
      }
      const retryAfter = retry && /^\d{1,3}$/.test(retry) ? Math.min(30, Math.max(2, Number(retry))) : undefined;
      return { status: response.status, body: await boundedJSON(response), ...(retryAfter ? { retryAfter } : {}) };
    },
    async readCookies() { return ephemeral.cookies.get(filter); },
    async install(cookie) {
      validateSessionCookie(cookie, root, Date.now());
      const before = await baseline;
      if (disposed || !before || !sameSnapshot(before, await persistent.cookies.get(filter))) throw new AuthFailure("session-install-failed");
      // Omit domain: passing a domain would turn this into a domain cookie and violate __Host- semantics.
      await persistent.cookies.set({
        url: root, name: SESSION_COOKIE, value: cookie.value, path: "/", secure: true, httpOnly: true,
        sameSite: "lax", expirationDate: cookie.expirationDate,
      });
      await persistent.cookies.flushStore();
      if (!matchingCookie(await persistent.cookies.get(filter), cookie)) throw new AuthFailure("session-install-failed");
    },
    async verify(cookie) {
      if (disposed || !matchingCookie(await persistent.cookies.get(filter), cookie)) return false;
      const response = await perform(persistent, "/api/me", "GET", undefined, AbortSignal.timeout(10_000));
      if (response.status !== 200) { if (response.body) await response.body.cancel(); return false; }
      const identity = await boundedJSON(response, 128 * 1024);
      if (!isRecord(identity) || typeof identity.id !== "string"
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(identity.id)) return false;
      const current = await persistent.cookies.get(filter);
      if (!matchingCookie(current, cookie)) return false;
      validateSessionCookie(current[0], root, Date.now());
      return true;
    },
    async rollback(cookie) {
      if (matchingCookie(await persistent.cookies.get(filter), cookie)) {
        await persistent.cookies.remove(root, SESSION_COOKIE);
        await persistent.cookies.flushStore();
      }
    },
    async logout() {
      // Only this attempt's jar is used: never logout a persistent/newer user's session.
      const response = await perform(ephemeral, "/auth/logout", "POST", {}, AbortSignal.timeout(5000));
      if (response.body) await response.body.cancel();
    },
    async dispose() {
      disposed = true;
      await ephemeral.closeAllConnections();
      await ephemeral.clearStorageData();
    },
  };
}
