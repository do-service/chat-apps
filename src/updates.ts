import type { Platform } from "./contract";
import type { UpdateError, UpdateMode, UpdateState } from "./update-contract";

export const UPDATE_INTERVAL = 6 * 60 * 60_000;
const MANUAL_COOLDOWN = 30_000;
export type UpdateCandidate = { version: string; releaseURL: string };
export type UpdateContext = { current(): boolean; foreground(): boolean };
export interface UpdatePort {
  check(): Promise<UpdateCandidate | null>;
  download(progress: (percent: number) => void): Promise<void>;
  confirm(context: UpdateContext): Promise<boolean>;
  install(failed: (redownload?: boolean) => void): void;
  dispose(): void;
}
export type UpdateOptions = {
  platform: Platform; currentVersion: string; mode: UpdateMode; port: UpdatePort;
  openRelease(url: string): Promise<void>; prepareQuit(): () => void; now?: () => number;
};

function failure(error: unknown, fallback: UpdateError): UpdateError {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "ERR_UPDATER_INVALID_SIGNATURE") return "signature-mismatch";
  if (code === "ERR_INVALID_RELEASE") return "invalid-release";
  return fallback;
}

export class UpdateService {
  private state: UpdateState;
  private candidate: UpdateCandidate | null = null;
  private pendingCheck: Promise<UpdateState> | null = null;
  private lastCheck = -Infinity;
  private confirmation = false;
  private downloaded = false;
  private disposed = false;
  constructor(private readonly options: UpdateOptions) {
    const disabled = options.mode === "unconfigured";
    this.state = { version: 1, platform: options.platform, currentVersion: options.currentVersion,
      currentBuild: null, channel: "preview", mode: options.mode, status: disabled ? "unavailable" : "idle",
      availableVersion: null, progress: null, error: disabled ? "unconfigured" : null };
  }
  getState(): UpdateState { return { ...this.state }; }
  private busy(): boolean {
    return this.confirmation || this.state.status === "downloading" || this.state.status === "installing" || this.state.status === "ready";
  }
  async check(automatic = false): Promise<UpdateState> {
    if (this.disposed || this.options.mode === "unconfigured" || this.busy()) return this.getState();
    if (this.pendingCheck) return this.pendingCheck;
    const now = this.options.now?.() ?? Date.now();
    if (now - this.lastCheck < (automatic ? UPDATE_INTERVAL : MANUAL_COOLDOWN)) return this.getState();
    this.lastCheck = now;
    this.state = { ...this.state, status: "checking", error: null };
    this.pendingCheck = this.performCheck();
    try { return await this.pendingCheck; }
    finally { this.pendingCheck = null; }
  }
  private async performCheck(): Promise<UpdateState> {
    try {
      const candidate = await this.options.port.check();
      if (!this.disposed) {
        this.candidate = candidate;
        this.state = { ...this.state, status: candidate ? "available" : "idle", availableVersion: candidate?.version ?? null, progress: null, error: null };
      }
    } catch (error) {
      if (!this.disposed) {
        this.candidate = null;
        this.state = { ...this.state, status: "error", availableVersion: null, progress: null, error: failure(error, "network") };
      }
    }
    return this.getState();
  }
  async download(): Promise<UpdateState> {
    if (this.disposed || this.options.mode !== "install" || !this.candidate
      || !["available", "error"].includes(this.state.status)) return this.getState();
    this.downloaded = false;
    this.state = { ...this.state, status: "downloading", progress: 0, error: null };
    void this.performDownload();
    return this.getState();
  }
  private async performDownload(): Promise<void> {
    try {
      await this.options.port.download((percent) => {
        if (!this.disposed && this.state.status === "downloading" && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
          this.state = { ...this.state, progress: percent };
        }
      });
      if (!this.disposed) { this.downloaded = true; this.state = { ...this.state, status: "ready", progress: 100, error: null }; }
    } catch (error) {
      if (!this.disposed) this.state = { ...this.state, status: "error", progress: null, error: failure(error, "download-failed") };
    }
  }
  async install(context: UpdateContext): Promise<UpdateState> {
    const ready = this.downloaded && (this.state.status === "ready" || (this.state.status === "error" && this.state.error === "install-failed"));
    if (this.disposed || this.options.mode !== "install" || !ready || this.confirmation
      || !context.current() || !context.foreground()) return this.getState();
    this.confirmation = true;
    let rollback: (() => void) | undefined;
    try {
      const confirmed = await this.options.port.confirm(context);
      if (confirmed && !this.disposed && context.current() && context.foreground()) {
        this.state = { ...this.state, status: "installing", error: null };
        // electron-updater closes windows before before-quit: close-to-hide must already be bypassed.
        rollback = this.options.prepareQuit();
        const failed = (redownload = false) => {
          rollback?.(); rollback = undefined;
          if (redownload) this.downloaded = false;
          if (!this.disposed) this.state = { ...this.state, status: "error", error: redownload ? "download-failed" : "install-failed" };
        };
        this.options.port.install(failed);
      }
    } catch {
      rollback?.();
      if (!this.disposed) this.state = { ...this.state, status: "error", error: "install-failed" };
    } finally { this.confirmation = false; }
    return this.getState();
  }
  async openRelease(context: UpdateContext): Promise<UpdateState> {
    if (this.disposed || !this.candidate || !context.current() || !context.foreground()) return this.getState();
    try { await this.options.openRelease(this.candidate.releaseURL); }
    catch { if (!this.disposed) this.state = { ...this.state, status: "error", error: "network" }; }
    return this.getState();
  }
  dispose(): void { this.disposed = true; this.options.port.dispose(); }
}
