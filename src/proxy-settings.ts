import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { domainToASCII } from "node:url";
import { isRecord } from "./contract";

type ProxyScope = "check" | "all";
export type ProxySettings =
  | { mode: "default" | "system" | "direct"; scope: ProxyScope }
  | { mode: "http" | "https" | "socks5"; scope: ProxyScope; host: string; port: number };

export const defaultProxySettings: ProxySettings = { mode: "default", scope: "check" };
const maxSettingsBytes = 4096;

function invalid(): never { throw new TypeError("Invalid proxy settings"); }

function proxyHost(value: unknown): string {
  if (typeof value !== "string" || value.length > 253 || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  const host = value.trim();
  const ip = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(ip) === 6) return new URL(`http://[${ip}]`).hostname;
  if (isIP(host) === 4) return host;
  if (!host || /[\s:/\\@?#%=;,\[\]]/u.test(host)) return invalid();
  // Parse DNS labels, not URLs or alternate IPv4 spellings that Chromium could reinterpret.
  const labels = host.replace(/\.$/u, "").split(".");
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/iu.test(labels.at(-1) ?? "")) return invalid();
  const ascii = domainToASCII(host).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.replace(/\.$/u, "").split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return invalid();
  return ascii;
}

export function parseProxySettings(value: unknown): ProxySettings {
  if (!isRecord(value) || (value.scope !== "all" && value.scope !== "check")) return invalid();
  const { mode, scope, port } = value;
  if (mode === "default" || mode === "direct" || mode === "system") {
    if (Object.keys(value).length !== 2) return invalid();
    return { mode, scope };
  }
  if ((mode !== "http" && mode !== "https" && mode !== "socks5") || Object.keys(value).length !== 4
      || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return invalid();
  return { mode, scope, host: proxyHost(value.host), port };
}

type Routes = { chat?: Electron.ProxyConfig; metadata?: Electron.ProxyConfig; download?: Electron.ProxyConfig; restrictWebRTC: boolean };
export function proxyRoutes(value: ProxySettings): Routes {
  if (value.mode === "default") return { restrictWebRTC: false };
  let route: Electron.ProxyConfig;
  if ("host" in value) {
    route = { mode: "fixed_servers", proxyRules: `${value.mode}://${value.host}:${value.port}`, proxyBypassRules: "<-loopback>" };
  } else route = { mode: value.mode };
  if (value.scope === "check") return { metadata: route, restrictWebRTC: false };
  return { chat: route, metadata: route, download: route, restrictWebRTC: value.mode !== "direct" };
}

export function readProxySettings(path: string): ProxySettings {
  if (!isAbsolute(path)) return invalid();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return defaultProxySettings;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxSettingsBytes) return invalid();
    const buffer = Buffer.alloc(maxSettingsBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, null);
      if (!bytes) break;
      length += bytes;
    }
    if (length > maxSettingsBytes) return invalid();
    const file: unknown = JSON.parse(buffer.toString("utf8", 0, length));
    if (!isRecord(file) || file.version !== 1 || Object.keys(file).length !== 2) return invalid();
    return parseProxySettings(file.settings);
  } finally { closeSync(fd); }
}

export function writeProxySettings(path: string, value: unknown): ProxySettings {
  if (!isAbsolute(path)) return invalid();
  const settings = parseProxySettings(value);
  const temporary = join(dirname(path), `.proxy-settings-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, settings }), "utf8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    renamed = true;
  } finally { if (!renamed) unlinkSync(temporary); }
  return settings;
}
