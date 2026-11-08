import { createHash, randomBytes } from "node:crypto";
import {
  isLoginRequest, isRecord, type DesktopAuthErrorCode, type DesktopAuthState, type DesktopLoginRequest, type Platform,
} from "./contract";
import { validateAppURL } from "./security";

export const AUTH_TTL_MS = 300_000;
export const SESSION_COOKIE = "__Host-session";
export type AuthPath = "/auth/desktop/transactions" | "/auth/desktop/exchange" | "/auth/desktop/ack" | "/auth/desktop/cancel";
export type AuthResponse = { status: number; body?: unknown; retryAfter?: number };
export type AuthCookie = {
  name: string; value: string; domain: string; hostOnly: boolean; path: string;
  secure: boolean; httpOnly: boolean; sameSite: "lax"; expirationDate: number;
};
export type AuthAttemptPort = {
  post(path: AuthPath, body: unknown, signal: AbortSignal): Promise<AuthResponse>;
  readCookies(): Promise<unknown[]>;
  prepareCommit?(): Promise<void>;
  finishCommit?(): Promise<void>;
  install(cookie: AuthCookie): Promise<void>;
  verify(cookie: AuthCookie): Promise<boolean>;
  rollback(cookie: AuthCookie): Promise<void>;
  logout(): Promise<void>;
  dispose(): Promise<void>;
};
export type AuthProof = { verifier: string; challenge: string };
type Options = {
  appURL: string; platform: Platform; enabled: boolean;
  createAttempt(): AuthAttemptPort;
  openBrowser(url: string): Promise<void>;
  emit(state: DesktopAuthState): void;
  onSuccess(): void;
  onCommitFailure?(): void;
  now?: () => number;
  proof?: () => AuthProof;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
};
type Transaction = { transaction_id: string; authorization_url: string; user_code: string; expires_in: number; interval: number };
type Attempt = {
  port: AuthAttemptPort; proof: AuthProof; controller: AbortController;
  deadline: number; transaction?: Transaction; installed?: AuthCookie; completed: boolean; committing: boolean;
  cancelExpiry?: () => void;
};

export class AuthFailure extends Error {
  constructor(readonly code: DesktopAuthErrorCode) { super(code); }
}
export function generateAuthProof(): AuthProof {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function opaque(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
export function validateTransaction(value: unknown, appURL: string): Transaction {
  if (!isRecord(value) || !exactKeys(value, ["transaction_id", "authorization_url", "user_code", "expires_in", "interval"])
    || !opaque(value.transaction_id) || typeof value.authorization_url !== "string"
    || typeof value.user_code !== "string" || !/^[23456789BCDFGHJKMNPQ]{4}-[23456789BCDFGHJKMNPQ]{4}$/.test(value.user_code)
    || typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 300
    || typeof value.interval !== "number" || !Number.isSafeInteger(value.interval) || value.interval < 2 || value.interval > 30) throw new AuthFailure("invalid-response");
  const prefix = `${new URL(validateAppURL(appURL)).origin}/auth/desktop/authorize?request=`;
  const handle = value.authorization_url.slice(prefix.length);
  if (!value.authorization_url.startsWith(prefix) || !opaque(handle) || handle === value.transaction_id) throw new AuthFailure("invalid-response");
  return {
    transaction_id: value.transaction_id, authorization_url: value.authorization_url,
    user_code: value.user_code, expires_in: value.expires_in, interval: value.interval,
  };
}
export function validateSessionCookie(value: unknown, appURL: string, now: number): AuthCookie {
  const host = new URL(validateAppURL(appURL)).hostname;
  if (!isRecord(value) || value.name !== SESSION_COOKIE || !opaque(value.value)
    || value.domain !== host || value.hostOnly !== true || value.path !== "/" || value.secure !== true
    || value.httpOnly !== true || value.sameSite !== "lax" || typeof value.expirationDate !== "number"
    || !Number.isFinite(value.expirationDate) || value.expirationDate <= now / 1000) throw new AuthFailure("session-install-failed");
  return {
    name: SESSION_COOKIE, value: value.value, domain: host, hostOnly: true, path: "/",
    secure: true, httpOnly: true, sameSite: "lax", expirationDate: value.expirationDate,
  };
}
const defaultSleep = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new AuthFailure("network")); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
  timer.unref();
  const abort = () => { clearTimeout(timer); reject(new AuthFailure("network")); };
  signal.addEventListener("abort", abort, { once: true });
});
function responseStatus(response: AuthResponse, status: string): boolean {
  return isRecord(response.body) && exactKeys(response.body, ["status"]) && response.body.status === status;
}

export class DesktopAuthService {
  private state: DesktopAuthState = { status: "idle" };
  private attempt: Attempt | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly schedule: (callback: () => void, milliseconds: number) => () => void;
  constructor(private readonly options: Options) {
    validateAppURL(options.appURL);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.schedule = options.schedule ?? ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds); timer.unref();
      return () => clearTimeout(timer);
    });
  }
  getState(): DesktopAuthState { return { ...this.state }; }
  begin(request: DesktopLoginRequest): DesktopAuthState {
    if (!isLoginRequest(request)) throw new AuthFailure("invalid-response");
    if (this.disposed || !this.options.enabled) return { status: "error", code: "unavailable" };
    if (this.attempt) return this.getState();
    const proof = (this.options.proof ?? generateAuthProof)();
    if (!opaque(proof.verifier) || !opaque(proof.challenge)) throw new AuthFailure("invalid-response");
    const attempt: Attempt = {
      proof, port: this.options.createAttempt(), controller: new AbortController(),
      deadline: this.now() + AUTH_TTL_MS, completed: false, committing: false,
    };
    this.attempt = attempt;
    this.armExpiry(attempt);
    this.publish({ status: "starting" });
    void this.run(attempt, request.door);
    return this.getState();
  }
  cancel(): void {
    if (!this.attempt || this.state.status === "committing") return;
    const attempt = this.attempt;
    this.attempt = null;
    attempt.cancelExpiry?.();
    attempt.controller.abort();
    this.publish({ status: "cancelled" });
    // Cleanup uses a separate bounded signal: cancelling polling must not cancel server-side revocation.
    void this.cleanup(attempt);
  }
  dispose(): void {
    this.disposed = true;
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    attempt.cancelExpiry?.();
    attempt.controller.abort();
    void this.cleanup(attempt);
  }
  private publish(state: DesktopAuthState): void {
    this.state = state;
    if (!this.disposed) this.options.emit(this.getState());
  }
  private current(attempt: Attempt): boolean { return !this.disposed && this.attempt === attempt && !attempt.controller.signal.aborted; }
  private proofBody(attempt: Attempt): { transaction_id: string; code_verifier: string } {
    if (!attempt.transaction) throw new AuthFailure("invalid-response");
    return { transaction_id: attempt.transaction.transaction_id, code_verifier: attempt.proof.verifier };
  }
  private async cookie(attempt: Attempt): Promise<AuthCookie | undefined> {
    const cookies = await attempt.port.readCookies();
    const sessions = cookies.filter((value) => isRecord(value) && value.name === SESSION_COOKIE);
    if (sessions.length === 0) return undefined;
    if (sessions.length !== 1) throw new AuthFailure("session-install-failed");
    return validateSessionCookie(sessions[0], this.options.appURL, this.now());
  }
  private armExpiry(attempt: Attempt): void {
    attempt.cancelExpiry?.();
    attempt.cancelExpiry = this.schedule(() => {
      if (!this.current(attempt) || attempt.committing) return;
      this.finish(attempt, { status: "expired" });
      attempt.controller.abort();
      void this.cleanup(attempt);
    }, Math.max(1, attempt.deadline - this.now()));
  }
  private finish(attempt: Attempt, state: DesktopAuthState): void {
    if (!this.current(attempt)) return;
    this.attempt = null;
    attempt.cancelExpiry?.();
    this.publish(state);
  }
  private async run(attempt: Attempt, door: string): Promise<void> {
    let commitError: DesktopAuthState | undefined;
    try {
      const response = await attempt.port.post("/auth/desktop/transactions", {
        client_id: "chat-desktop", platform: this.options.platform, door,
        code_challenge: attempt.proof.challenge, code_challenge_method: "S256",
      }, attempt.controller.signal);
      if (response.status === 404) throw new AuthFailure("unsupported-server");
      if (response.status === 503 || response.status >= 500) throw new AuthFailure("unavailable");
      if (response.status !== 201) throw new AuthFailure("invalid-response");
      attempt.transaction = validateTransaction(response.body, this.options.appURL);
      if (!this.current(attempt)) return;
      attempt.deadline = Math.min(attempt.deadline, this.now() + attempt.transaction.expires_in * 1000);
      this.armExpiry(attempt);
      this.publish({ status: "waiting", userCode: attempt.transaction.user_code, expiresAt: attempt.deadline });
      await this.options.openBrowser(attempt.transaction.authorization_url);
      let interval = attempt.transaction.interval * 1000;
      while (this.current(attempt)) {
        if (this.now() >= attempt.deadline) { this.finish(attempt, { status: "expired" }); break; }
        await this.sleep(Math.min(interval, attempt.deadline - this.now()), attempt.controller.signal);
        if (!this.current(attempt)) break;
        if (this.now() >= attempt.deadline) { this.finish(attempt, { status: "expired" }); break; }
        let result: AuthResponse;
        try {
          result = await attempt.port.post("/auth/desktop/exchange", this.proofBody(attempt), attempt.controller.signal);
        } catch (error) {
          if (!this.current(attempt)) break;
          // A lost 204 may already have staged Set-Cookie in this exact fresh jar.
          const cookie = await this.cookie(attempt);
          if (cookie) { await this.commit(attempt, cookie); break; }
          if (error instanceof AuthFailure && error.code === "invalid-response") throw error;
          interval = Math.min(30_000, interval + 2000);
          continue;
        }
        if (!this.current(attempt)) break;
        if (result.status === 204 || (result.status === 410 && responseStatus(result, "consumed"))) {
          const cookie = await this.cookie(attempt);
          if (!cookie) throw new AuthFailure("session-install-failed");
          await this.commit(attempt, cookie);
          break;
        }
        if (result.status === 202 && isRecord(result.body) && exactKeys(result.body, ["status", "interval"])
            && result.body.status === "pending" && typeof result.body.interval === "number"
            && Number.isSafeInteger(result.body.interval) && result.body.interval >= 2 && result.body.interval <= 30) {
          interval = result.body.interval * 1000;
        } else if (result.status === 429 && responseStatus(result, "slow_down")) {
          const retryAfter = result.retryAfter ?? 2;
          if (!Number.isSafeInteger(retryAfter) || retryAfter < 2 || retryAfter > 30) throw new AuthFailure("invalid-response");
          interval = Math.min(30_000, Math.max(interval + 2000, retryAfter * 1000));
        } else if (result.status === 404) throw new AuthFailure("unsupported-server");
        else if (result.status === 403 && responseStatus(result, "denied")) { this.finish(attempt, { status: "denied" }); break; }
        else if (result.status === 410 && (responseStatus(result, "expired") || responseStatus(result, "cancelled"))) {
          this.finish(attempt, { status: responseStatus(result, "expired") ? "expired" : "cancelled" }); break;
        } else if (result.status === 503) throw new AuthFailure("unavailable");
        else if (result.status >= 500) interval = Math.min(30_000, interval + 2000);
        else throw new AuthFailure(result.status === 400 ? "auth-failed" : "invalid-response");
      }
    } catch (error) {
      const state: DesktopAuthState = { status: "error", code: error instanceof AuthFailure ? error.code : "network" };
      if (attempt.committing) commitError = state;
      else this.finish(attempt, state);
    } finally {
      if (!attempt.completed) await this.cleanup(attempt);
      else { try { await attempt.port.dispose(); } catch { /* Ephemeral cleanup never changes authenticated success. */ } }
      if (attempt.committing) {
        try { await attempt.port.finishCommit?.(); }
        catch { commitError = { status: "error", code: "session-install-failed" }; }
        if (this.current(attempt)) {
          if (attempt.completed && !commitError) {
            this.finish(attempt, { status: "success" });
            this.options.onSuccess();
          } else {
            this.finish(attempt, commitError ?? { status: "error", code: "session-install-failed" });
            this.options.onCommitFailure?.();
          }
        }
      }
    }
  }
  private async commit(attempt: Attempt, cookie: AuthCookie): Promise<void> {
    if (!this.current(attempt)) return;
    if (this.now() >= attempt.deadline) { this.finish(attempt, { status: "expired" }); return; }
    attempt.committing = true;
    this.publish({ status: "committing" });
    try {
      await attempt.port.prepareCommit?.();
      if (!this.current(attempt)) throw new AuthFailure("session-install-failed");
      attempt.installed = cookie;
      await attempt.port.install(cookie);
      if (!this.current(attempt)) throw new AuthFailure("session-install-failed");
      if (!await attempt.port.verify(cookie)) throw new AuthFailure("auth-failed");
      if (!this.current(attempt) || this.now() >= attempt.deadline) throw new AuthFailure("auth-failed");
      // ACK must carry both the proof body and the same ephemeral cookie, after persistent verification.
      let acknowledged = false;
      for (let retry = 0; retry < 3 && this.current(attempt) && this.now() < attempt.deadline; retry++) {
        let ack: AuthResponse | undefined;
        let delay = 2000;
        try {
          ack = await attempt.port.post("/auth/desktop/ack", this.proofBody(attempt), attempt.controller.signal);
        } catch (error) {
          if (error instanceof AuthFailure && error.code === "invalid-response") throw error;
          // Lost ACK is retried with the identical proof and fresh-jar cookie; the server operation is idempotent.
        }
        if (ack?.status === 204) { acknowledged = true; break; }
        if (ack?.status === 429) {
          const retryAfter = ack.retryAfter ?? 2;
          if (!responseStatus(ack, "slow_down") || !Number.isSafeInteger(retryAfter) || retryAfter < 2 || retryAfter > 30) {
            throw new AuthFailure("invalid-response");
          }
          delay = retryAfter * 1000;
        } else if (ack && ack.status < 500) break;
        const remaining = attempt.deadline - this.now();
        if (retry < 2 && remaining > 0) await this.sleep(Math.min(delay, remaining), attempt.controller.signal);
      }
      if (!this.current(attempt) || !acknowledged || this.now() >= attempt.deadline) throw new AuthFailure("auth-failed");
      attempt.completed = true;
    } catch (error) {
      throw error instanceof AuthFailure ? error : new AuthFailure("session-install-failed");
    }
  }
  private async cleanup(attempt: Attempt): Promise<void> {
    if (attempt.completed) return;
    if (attempt.transaction) {
      try { await attempt.port.post("/auth/desktop/cancel", this.proofBody(attempt), AbortSignal.timeout(5000)); }
      catch { /* Provisional server sessions also expire; never leak cleanup details. */ }
    }
    try { await attempt.port.logout(); } catch { /* Best effort revoke of this attempt's fresh jar only. */ }
    if (attempt.installed) {
      try { await attempt.port.rollback(attempt.installed); } catch { /* Adapter only removes a matching newly installed cookie. */ }
    }
    try { await attempt.port.dispose(); } catch { /* No renderer or persistent jar is exposed. */ }
  }
}
