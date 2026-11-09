import type { BrowserWindow, SystemPreferences, WebContents, WebFrameMain } from "electron";
import { isRecord } from "./contract";
import { isTrustedURL } from "./security";

type MediaKind = "microphone" | "camera";
const MEDIA_DIAGNOSTICS: Record<MediaKind, string> = {
  microphone: "Микрофон недоступен. Откройте «Системные настройки → Конфиденциальность и безопасность → Микрофон», разрешите доступ Chat Desktop и перезапустите приложение. Демонстрация экрана запрещена.",
  camera: "Камера недоступна. Откройте «Системные настройки → Конфиденциальность и безопасность → Камера», разрешите доступ Chat Desktop и перезапустите приложение. Демонстрация экрана запрещена.",
};

type Owner = Pick<BrowserWindow, "isDestroyed" | "webContents">;
type Context = { owner: Owner; contents: WebContents; frame: WebFrameMain; url: string; generation: number };
type Options = {
  platform: string;
  spike: boolean;
  trustedOrigin: string;
  owner(): Owner | null;
  generation(): number;
  system: Pick<SystemPreferences, "getMediaAccessStatus" | "askForMediaAccess">;
  diagnose(message: string): void;
};

export function createMediaPermissionPolicy(options: Options) {
  const consent: Record<MediaKind, Promise<boolean> | null> = { microphone: null, camera: null };
  const diagnose = (kind: MediaKind) => options.diagnose(MEDIA_DIAGNOSTICS[kind]);
  // Chromium serializes origin URLs with a trailing slash in some permission paths.
  const agrees = (value: unknown) => value === options.trustedOrigin || value === `${options.trustedOrigin}/`;
  const context = (contents: unknown, details: unknown): Context | null => {
    if (options.platform !== "darwin" || options.spike || !options.trustedOrigin.startsWith("https://")
        || !isRecord(details) || details.isMainFrame !== true) return null;
    const owner = options.owner();
    if (!owner || owner.isDestroyed() || contents !== owner.webContents || owner.webContents.isDestroyed()) return null;
    const frame = owner.webContents.mainFrame;
    if (frame.isDestroyed() || frame.parent !== null || frame.origin !== options.trustedOrigin
        || !isTrustedURL(frame.url, options.trustedOrigin) || owner.webContents.getURL() !== frame.url
        || details.requestingUrl !== frame.url) return null;
    if ((details.securityOrigin !== undefined && !agrees(details.securityOrigin))
        || (details.requestingOrigin !== undefined && !agrees(details.requestingOrigin))
        || (details.embeddingOrigin !== undefined && !agrees(details.embeddingOrigin))) return null;
    return { owner, contents: owner.webContents, frame, url: frame.url, generation: options.generation() };
  };
  const current = (initial: Context, contents: unknown, details: unknown): boolean => {
    const live = context(contents, details);
    return live !== null && live.owner === initial.owner && live.contents === initial.contents
      && live.frame === initial.frame && live.url === initial.url && live.generation === initial.generation;
  };
  const granted = (kind: MediaKind): boolean => {
    try {
      if (options.system.getMediaAccessStatus(kind) === "granted") return true;
    } catch { /* Report only the device-specific recovery instructions, never raw OS errors. */ }
    diagnose(kind);
    return false;
  };
  const access = async (kind: MediaKind, valid: () => boolean): Promise<boolean> => {
    try {
      if (!valid()) return false;
      const status = options.system.getMediaAccessStatus(kind);
      if (status === "granted") return true;
      if (status !== "not-determined") { diagnose(kind); return false; }
      // Coalesce only the same device's OS prompt, never consent for another device or origin.
      // Revalidate before each new prompt: a mixed request may have awaited the microphone first.
      if (!valid()) return false;
      const pending = consent[kind] ?? options.system.askForMediaAccess(kind);
      consent[kind] = pending;
      try {
        const allowed = await pending;
        if (!valid()) return false;
        if (allowed === true) return granted(kind);
        diagnose(kind);
        return false;
      } finally { if (consent[kind] === pending) consent[kind] = null; }
    } catch { diagnose(kind); return false; }
  };
  return {
    request(contents: unknown, permission: string, callback: (allowed: boolean) => void, details: unknown): void {
      let answered = false;
      const answer = (allowed: boolean) => { if (!answered) { answered = true; callback(allowed); } };
      const kinds: MediaKind[] = [];
      try {
        if (permission !== "media" || !isRecord(details) || !Array.isArray(details.mediaTypes)) { answer(false); return; }
        // Canonical order also rejects empty, duplicate, sparse and unknown media types.
        if (details.mediaTypes.includes("audio")) kinds.push("microphone");
        if (details.mediaTypes.includes("video")) kinds.push("camera");
        if (kinds.length === 0 || kinds.length !== details.mediaTypes.length) { answer(false); return; }
        const initial = context(contents, details);
        if (!initial) { answer(false); return; }
        const valid = () => current(initial, contents, details);
        const authorize = async (): Promise<boolean> => {
          for (const kind of kinds) {
            if (!valid() || !await access(kind, valid) || !valid()) return false;
          }
          return true;
        };
        void authorize().then((allowed) => {
          let result = false;
          try {
            // Recheck all devices and the document at the callback boundary, not an earlier microtask.
            result = allowed && valid() && kinds.every(granted) && valid();
          } catch { diagnose(kinds[0] ?? "microphone"); }
          answer(result);
        }, () => { diagnose(kinds[0] ?? "microphone"); answer(false); });
      } catch { diagnose(kinds[0] ?? "microphone"); answer(false); }
    },
    check(contents: unknown, permission: string, requestingOrigin: string, details: unknown): boolean {
      let kind: MediaKind = "microphone";
      try {
        if (permission !== "media" || !isRecord(details) || (details.mediaType !== "audio" && details.mediaType !== "video")
            || !agrees(requestingOrigin)) return false;
        kind = details.mediaType === "audio" ? "microphone" : "camera";
        const initial = context(contents, details);
        if (!initial) return false;
        const status = options.system.getMediaAccessStatus(kind);
        if (status === "granted") return current(initial, contents, details);
        if (status !== "not-determined") diagnose(kind);
        return false;
      } catch { diagnose(kind); return false; }
    },
  };
}
