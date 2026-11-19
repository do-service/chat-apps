import { app, dialog, net, session } from "electron";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppImageUpdater, CancellationToken, NsisUpdater, Provider, type UpdateInfo, type ResolvedUpdateFileInfo } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { parseUpdateInfo } from "electron-updater/out/providers/Provider";
import type { UpdateInfoAndProvider } from "electron-updater/out/AppUpdater";
import { isRecord, type Platform } from "./contract";
import type { RuntimeConfiguration } from "./config";
import type { UpdateMode } from "./update-contract";
import { allowedUpdateURL, invalidRelease, MAX_METADATA_BYTES, selectRelease, validateUpdateInfo, RELEASE_API, type DesktopRelease } from "./update-release";
import { readPublicUpdateMetadata } from "./update-transport";
import { createElectronUpdateRequest } from "./electron-update-request";
import type { UpdateCandidate, UpdateContext, UpdatePort } from "./updates";
import type { InstallOptions } from "electron-updater/out/BaseUpdater";
import { installAppImage, updateCacheFailure, verifyCachedInstaller, writableAppImage, type InstallerIntegrity } from "./update-files";
import { verifyWindowsSignature } from "./update-signature";
export { writableAppImage } from "./update-files";

export const UPDATE_DOWNLOAD_TIMEOUT = 15 * 60_000;
export const UPDATE_DOWNLOAD_IDLE_TIMEOUT = 60_000;
type Owner = { window(): Electron.BrowserWindow | null };
const feed = { provider: "github", owner: "do-service", repo: "chat-apps", channel: "preview", releaseType: "prerelease" } satisfies ConstructorParameters<typeof NsisUpdater>[0];

function installerIntegrity(info: UpdateInfo): InstallerIntegrity {
  const file = info.files[0];
  if (!file || typeof file.size !== "number") throw invalidRelease();
  return { size: file.size, sha512: file.sha512 };
}
function diskFeed(): unknown {
  try {
    const path = join(process.resourcesPath, "app-update.yml");
    if (lstatSync(path).size > MAX_METADATA_BYTES) return null;
    return parseUpdateInfo(readFileSync(path, "utf8"), "app-update.yml", new URL("https://github.com/do-service/chat-apps/"));
  } catch { return null; }
}
export function desktopUpdateMode(config: RuntimeConfiguration, os: Platform, packaged: boolean, feedConfig: unknown, imageWritable: boolean): UpdateMode {
  if (config.spike || !packaged || config.updateDistribution !== "github-preview") return "unconfigured";
  if (os === "darwin") return "external";
  if (!isRecord(feedConfig) || feedConfig.provider !== "github" || feedConfig.owner !== "do-service" || feedConfig.repo !== "chat-apps"
    || feedConfig.channel !== "preview" || (feedConfig.host !== undefined && feedConfig.host !== "github.com")
    || (feedConfig.protocol !== undefined && feedConfig.protocol !== "https") || feedConfig.token !== undefined || feedConfig.private === true) return "external";
  if (os === "linux") return imageWritable ? "install" : "external";
  const names: unknown = feedConfig.publisherName;
  const valid = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
  return valid(names) || (Array.isArray(names) && names.length > 0 && names.length <= 16 && names.every(valid)) ? "install" : "external";
}

class CandidateProvider extends Provider<UpdateInfo> {
  constructor(private readonly release: DesktopRelease, private readonly info: UpdateInfo, os: Platform) {
    super({ platform: os, executor: new ElectronHttpExecutor(), isUseMultipleRangeRequest: false });
  }
  async getLatestVersion(): Promise<UpdateInfo> { return this.info; }
  resolveFiles(): ResolvedUpdateFileInfo[] { return [{ url: new URL(this.release.asset.url), info: this.info.files[0] }]; }
}
class PreviewNsisUpdater extends NsisUpdater {
  constructor(private readonly load: () => UpdateInfoAndProvider) { super(feed); this.verifyUpdateCodeSignature = verifyWindowsSignature; }
  protected override async getUpdateInfoAndProvider(): Promise<UpdateInfoAndProvider> { return this.load(); }
  protected override doInstall(options: InstallOptions): boolean {
    verifyCachedInstaller(this.installerPath, installerIntegrity(this.load().info));
    return super.doInstall(options);
  }
  resetInstallAttempt(): void { this.quitAndInstallCalled = false; }
}
class PreviewAppImageUpdater extends AppImageUpdater {
  constructor(private readonly load: () => UpdateInfoAndProvider) { super(feed); }
  protected override async getUpdateInfoAndProvider(): Promise<UpdateInfoAndProvider> { return this.load(); }
  protected override doInstall(): boolean {
    installAppImage(process.env.APPIMAGE, this.installerPath, installerIntegrity(this.load().info), (path) => app.relaunch({ execPath: path }));
    return true;
  }
  resetInstallAttempt(): void { this.quitAndInstallCalled = false; }
}

export function createElectronUpdatePort(
  config: RuntimeConfiguration, os: Platform, owner: Owner,
  proxy?: { metadata?: Electron.ProxyConfig; download?: Electron.ProxyConfig },
): { mode: UpdateMode; port: UpdatePort } {
  const feedConfig = diskFeed();
  const mode = desktopUpdateMode(config, os, app.isPackaged, feedConfig, writableAppImage(process.env.APPIMAGE));
  const names: unknown = isRecord(feedConfig) ? feedConfig.publisherName : null;
  const publishers = typeof names === "string" ? [names] : Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  let selected: DesktopRelease | null = null;
  let loaded: UpdateInfoAndProvider | null = null;
  const controller = new AbortController();
  let cancellation: CancellationToken | null = null;
  let confirmation: AbortController | null = null;
  let installFailure: ((redownload?: boolean) => void) | null = null;
  let progress: ((percent: number) => void) | null = null;
  let installFailed = false;
  let binaryRedirects = 0;
  const load = () => { if (!loaded) throw invalidRelease(); return loaded; };
  const updater = mode !== "install" ? null : os === "win32" ? new PreviewNsisUpdater(load) : new PreviewAppImageUpdater(load);
  const metadataProxy = proxy?.metadata;
  let metadataSetup: Promise<Electron.Session> | undefined;
  const metadataRequest = metadataProxy && createElectronUpdateRequest(() => metadataSetup ??= (async () => {
    const ses = session.fromPartition(`chat-update-metadata-${randomUUID()}`, { cache: false });
    await ses.setProxy(metadataProxy);
    return ses;
  })(), net.request);
  const downloadProxy = proxy?.download;
  let downloadSetup: Promise<void> | undefined;
  if (updater) {
    updater.logger = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = true;
    updater.channel = "preview";
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    // A full, bounded installer avoids extra blockmap endpoints and retains upstream hash/signature validation.
    updater.disableDifferentialDownload = true;
    updater.on("error", (error) => { if (installFailure) { installFailed = true; updater.resetInstallAttempt(); installFailure(updateCacheFailure(error)); } });
    updater.on("download-progress", (info) => { progress?.(info.percent); });
    const ses = updater.netSession;
    ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      callback({ cancel: !cancellation || cancellation.cancelled || !selected || !allowedUpdateURL(details.url)
        || (new URL(details.url).hostname === "github.com" && details.url !== selected.asset.url) });
    });
    ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (_details, callback) => {
      callback({ requestHeaders: { Accept: "application/octet-stream", "User-Agent": "Chat-Desktop-Updates" } });
    });
    ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      const headers = details.responseHeaders ?? {};
      const length = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-length")?.[1]?.[0];
      const location = Object.entries(headers).find(([key]) => key.toLowerCase() === "location")?.[1]?.[0];
      const redirect = [301, 302, 303, 307, 308].includes(details.statusCode);
      let cancel = true;
      try {
        cancel = !cancellation || cancellation.cancelled || (redirect
          ? ++binaryRedirects > 8 || !location || !allowedUpdateURL(new URL(location, details.url).href)
          : details.statusCode !== 200 || !selected || !length || !/^\d+$/.test(length) || Number(length) !== selected.asset.size);
      } catch { /* Malformed redirects must complete the request callback with a denial. */ }
      callback({ cancel });
      if (cancel) cancellation?.cancel();
    });
  }
  const port: UpdatePort = {
    async check(): Promise<UpdateCandidate | null> {
      loaded = null; selected = null;
      const releases: unknown = JSON.parse(await readPublicUpdateMetadata(RELEASE_API, controller.signal, metadataRequest));
      const candidate = selectRelease(releases, os, process.arch, app.getVersion(), mode === "install");
      if (!candidate) return null;
      if (updater && candidate.metadataURL) {
        const raw = await readPublicUpdateMetadata(candidate.metadataURL, controller.signal, metadataRequest);
        let parsed: unknown;
        try { parsed = parseUpdateInfo(raw, "preview", new URL(candidate.metadataURL)); } catch { throw invalidRelease(); }
        const info = validateUpdateInfo(parsed, candidate);
        loaded = { info, provider: new CandidateProvider(candidate, info, os) };
        const result = await updater.checkForUpdates();
        if (!result?.isUpdateAvailable) { loaded = null; return null; }
      }
      selected = candidate;
      return { version: candidate.version, releaseURL: candidate.releaseURL };
    },
    async download(onProgress) {
      if (!updater || !selected || !loaded || controller.signal.aborted) throw invalidRelease();
      const token = new CancellationToken(); cancellation = token; binaryRedirects = 0;
      let expired: (() => void) | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        expired = () => { token.cancel(); reject(new Error("Update download timed out")); };
      });
      const expire = () => expired?.();
      const deadline = setTimeout(expire, UPDATE_DOWNLOAD_TIMEOUT); deadline.unref();
      let idle = setTimeout(expire, UPDATE_DOWNLOAD_IDLE_TIMEOUT); idle.unref();
      progress = (percent) => {
        clearTimeout(idle); idle = setTimeout(expire, UPDATE_DOWNLOAD_IDLE_TIMEOUT); idle.unref(); onProgress(percent);
      };
      const transfer = async () => {
        if (downloadProxy) {
          await token.createPromise<void>((resolve, reject) => {
            downloadSetup ??= (async () => {
              const ses = updater.netSession;
              await ses.setProxy(downloadProxy);
              await ses.closeAllConnections();
            })();
            void downloadSetup.then(resolve, reject);
          });
          if (token.cancelled || controller.signal.aborted) throw invalidRelease();
        }
        const paths = await updater.downloadUpdate(token);
        // Upstream may reuse a hash-valid cached download without running its signature task again.
        if (os === "win32" && (!paths[0] || await verifyWindowsSignature(publishers, paths[0]) !== null)) {
          throw Object.assign(new Error("Windows installer signature rejected"), { code: "ERR_UPDATER_INVALID_SIGNATURE" });
        }
      };
      try { await Promise.race([transfer(), timeout]); }
      finally { clearTimeout(deadline); clearTimeout(idle); cancellation = null; progress = null; expired = undefined; }
    },
    async confirm(context: UpdateContext) {
      const window = owner.window();
      if (!window || !context.current() || !context.foreground() || confirmation) return false;
      const prompt = new AbortController(); confirmation = prompt;
      const cancel = () => prompt.abort();
      window.on("hide", cancel); window.on("minimize", cancel); window.on("closed", cancel);
      window.webContents.on("did-start-navigation", cancel); window.webContents.on("render-process-gone", cancel);
      try {
        const result = await dialog.showMessageBox(window, { type: "warning", title: "Обновление Chat", message: `Установить Chat ${selected?.version ?? ""} и перезапустить приложение?`,
          detail: "Завершите звонки и передачу файлов, сохраните несохранённый текст. Приложение будет закрыто. Профиль и вход сохраняются.",
          buttons: ["Отмена", "Установить и перезапустить"], defaultId: 0, cancelId: 0, noLink: true, signal: prompt.signal });
        return !prompt.signal.aborted && result.response === 1 && context.current() && context.foreground();
      } finally {
        window.removeListener("hide", cancel); window.removeListener("minimize", cancel); window.removeListener("closed", cancel);
        window.webContents.removeListener("did-start-navigation", cancel); window.webContents.removeListener("render-process-gone", cancel);
        if (confirmation === prompt) confirmation = null;
      }
    },
    install(failed) {
      if (!updater || !selected || (os === "linux" && !writableAppImage(process.env.APPIMAGE))) throw invalidRelease();
      installFailed = false; installFailure = failed;
      // install() reports failure via both a boolean and an event, not a thrown exception.
      if (!updater.install(false, true)) {
        updater.resetInstallAttempt(); if (!installFailed) failed(); installFailure = null; return;
      }
      setImmediate(() => { if (!installFailed && !controller.signal.aborted) app.quit(); });
    },
    dispose() { controller.abort(); cancellation?.cancel(); confirmation?.abort(); installFailure = null; },
  };
  return { mode, port };
}
