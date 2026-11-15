// Independent optional bridge: existing authentication/notification capabilities stay unchanged.
export const UPDATE_BRIDGE_VERSION = 1;
export const UPDATE_REPOSITORY = "do-service/chat-apps";
export const UPDATE_CHANNEL = "preview";
export type UpdatePlatform = "darwin" | "win32" | "linux" | "android" | "ios";
export type UpdateMode = "install" | "external" | "unconfigured";
export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error" | "unavailable";
export type UpdateError = "network" | "invalid-release" | "download-failed" | "install-failed" | "permission-required" | "signature-mismatch" | "unsupported" | "unconfigured" | "busy";
export type UpdateState = {
  version: 1;
  platform: UpdatePlatform;
  currentVersion: string;
  currentBuild: string | null;
  channel: "preview";
  mode: UpdateMode;
  status: UpdateStatus;
  availableVersion: string | null;
  progress: number | null;
  error: UpdateError | null;
};
export interface NativeUpdatesBridge {
  readonly version: 1;
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<UpdateState>;
  openRelease(): Promise<UpdateState>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function versionString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value);
}
function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}
export function isUpdateState(value: unknown): value is UpdateState {
  const keys = ["version", "platform", "currentVersion", "currentBuild", "channel", "mode", "status", "availableVersion", "progress", "error"];
  if (!record(value) || Object.keys(value).length !== keys.length || !Object.keys(value).every((key) => keys.includes(key))) return false;
  return value.version === UPDATE_BRIDGE_VERSION
    && oneOf(value.platform, ["darwin", "win32", "linux", "android", "ios"])
    && versionString(value.currentVersion)
    && (value.currentBuild === null || (typeof value.currentBuild === "string" && /^[0-9]{1,18}$/.test(value.currentBuild)))
    && value.channel === UPDATE_CHANNEL
    && oneOf(value.mode, ["install", "external", "unconfigured"])
    && oneOf(value.status, ["idle", "checking", "available", "downloading", "ready", "installing", "error", "unavailable"])
    && (value.availableVersion === null || versionString(value.availableVersion))
    && (value.progress === null || (typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100))
    && (value.error === null || oneOf(value.error, ["network", "invalid-release", "download-failed", "install-failed", "permission-required", "signature-mismatch", "unsupported", "unconfigured", "busy"]));
}
export function isNativeUpdatesBridge(value: unknown): value is NativeUpdatesBridge {
  return record(value) && value.version === UPDATE_BRIDGE_VERSION
    && ["getState", "check", "download", "install", "openRelease"].every((key) => typeof value[key] === "function");
}
