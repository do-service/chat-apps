import type { UpdateInfo } from "electron-updater";
import { isRecord, type Platform } from "./contract";
import { UPDATE_REPOSITORY } from "./update-contract";

export const RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`;
export const MAX_METADATA_BYTES = 512 * 1024;
export const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const RELEASE_ROOT = `https://github.com/${UPDATE_REPOSITORY}/releases/`;
const BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
export type ReleaseAsset = { name: string; size: number; url: string };
export type DesktopRelease = { version: string; releaseURL: string; asset: ReleaseAsset; metadataURL: string | null };
export function invalidRelease(): Error { return Object.assign(new Error("Invalid update release"), { code: "ERR_INVALID_RELEASE" }); }

function components(value: string, preview: boolean): number[] | null {
  const match = (preview ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)$/
    : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/).exec(value);
  if (!match || value.length > 64) return null;
  const parts = match.slice(1).map((part) => part === undefined ? Infinity : Number(part));
  return parts.slice(0, 3).every(Number.isSafeInteger) && (parts[3] === Infinity || Number.isSafeInteger(parts[3])) ? parts : null;
}
export function newerPreview(version: string, current: string): boolean {
  const next = components(version, true); const previous = components(current, false);
  if (!next || !previous) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== previous[i]) return next[i] > previous[i];
  }
  return false;
}
export function allowedUpdateURL(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
    if (url.hostname === "github.com") return url.href.startsWith(`${RELEASE_ROOT}download/`)
      && /^v?[0-9A-Za-z.+-]+\/[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(url.pathname.slice(new URL(`${RELEASE_ROOT}download/`).pathname.length));
    return url.hostname === "release-assets.githubusercontent.com" && url.pathname.startsWith("/github-production-release-asset/");
  } catch { return false; }
}
function asset(value: unknown, base: string): ReleaseAsset | null {
  if (!isRecord(value) || typeof value.name !== "string" || !BASENAME.test(value.name)
    || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_INSTALLER_BYTES
    || value.browser_download_url !== base + value.name) return null;
  return { name: value.name, size: value.size, url: base + value.name };
}
export function selectRelease(value: unknown, platform: Platform, arch: string, current: string, install: boolean): DesktopRelease | null {
  if (!Array.isArray(value) || value.length > 30) throw invalidRelease();
  if ((platform !== "darwin" && arch !== "x64") || (arch !== "x64" && arch !== "arm64")) return null;
  const suffix = platform === "darwin" ? `mac-${arch}.dmg` : platform === "win32" ? "win-x64.exe" : "linux-x86_64.AppImage";
  const metadata = platform === "win32" ? "preview.yml" : "preview-linux.yml";
  let selected: DesktopRelease | null = null;
  for (const entry of value) {
    if (!isRecord(entry) || entry.draft !== false || entry.prerelease !== true || typeof entry.tag_name !== "string"
      || !/^v?\d+\.\d+\.\d+-preview\.\d+$/.test(entry.tag_name) || !Array.isArray(entry.assets) || entry.assets.length > 128) continue;
    const version = entry.tag_name.replace(/^v/, "");
    if (!newerPreview(version, current) || (selected && !newerPreview(version, selected.version))) continue;
    const base = `${RELEASE_ROOT}download/${entry.tag_name}/`;
    const assets = entry.assets.map((value: unknown) => asset(value, base)).filter((value): value is ReleaseAsset => value !== null);
    const binaries = assets.filter((value) => value.name.endsWith(`-${version}-${suffix}`));
    const manifests = assets.filter((value) => value.name === metadata && value.size <= MAX_METADATA_BYTES);
    if (binaries.length !== 1 || (install && manifests.length !== 1)) continue;
    selected = { version, releaseURL: `${RELEASE_ROOT}tag/${entry.tag_name}`, asset: binaries[0], metadataURL: install ? manifests[0].url : null };
  }
  return selected;
}
export function validateUpdateInfo(value: unknown, release: DesktopRelease): UpdateInfo {
  if (!isRecord(value) || value.version !== release.version || "packages" in value || !Array.isArray(value.files)
    || value.files.length === 0 || value.files.length > 16) throw invalidRelease();
  const files = value.files.filter((file: unknown) => isRecord(file) && file.url === release.asset.name);
  const file: unknown = files[0];
  if (files.length !== 1 || !isRecord(file) || typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
    || file.size !== release.asset.size) throw invalidRelease();
  if (value.minimumSystemVersion !== undefined
    && (typeof value.minimumSystemVersion !== "string" || !/^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(value.minimumSystemVersion))) throw invalidRelease();
  return { version: release.version, files: [{ url: release.asset.name, sha512: file.sha512, size: release.asset.size }],
    path: release.asset.name, sha512: file.sha512, releaseDate: "",
    ...(typeof value.minimumSystemVersion === "string" ? { minimumSystemVersion: value.minimumSystemVersion } : {}) };

}
