import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { APP_ID } from "./contract";

export type LinuxDesktopEntryOptions = {
  platform: string;
  appImage?: string;
  xdgDataHome?: string;
  homeDirectory: string;
  userDataDirectory: string;
  iconSourcePath: string;
};
export type LinuxDesktopEntryDescription = {
  desktopPath: string;
  iconPath: string;
  appImagePath: string;
  status: "missing" | "current" | "update";
};
export type LinuxDesktopEntryResult = "unsupported" | "declined" | "unchanged" | "registered";

type Plan = { description: LinuxDesktopEntryDescription; entry: string; previous: Buffer | null; icon: Buffer };
const HEADER = "[Desktop Entry]\nX-Chat-Desktop-Integration=1\nType=Application\nName=Chat Desktop Spike\n";
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function absolutePath(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f-\x9f]/u.test(path)) throw new Error("Unsafe absolute desktop integration path");
  return resolve(path);
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function stat(path: string) {
  try { return lstatSync(path); } catch (error) { if (missing(error)) return null; throw error; }
}
function safeDirectories(path: string, create: boolean): void {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const existing = stat(current);
    if (existing && !existing.isDirectory()) throw new Error("Unsafe directory or symlink in desktop integration path");
    if (!existing && create) mkdirSync(current, { mode: 0o700 });
  }
}
function regularFile(path: string, limit: number): Buffer | null {
  const existing = stat(path);
  if (!existing) return null;
  if (!existing.isFile() || existing.nlink !== 1 || existing.size > limit) throw new Error("Desktop integration requires a safe regular file");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== existing.ino || opened.dev !== existing.dev || opened.size > limit) {
      throw new Error("Desktop integration file changed during inspection");
    }
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}
function value(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll(" ", "\\s");
}
function executable(path: string): string {
  // Exec quoting is decoded after Desktop Entry string escaping; neither layer is shell evaluation.
  const quoted = path.replace(/[\\"$`]/gu, (character) => `\\${character}`).replaceAll("%", "%%");
  return `"${quoted.replaceAll("\\", "\\\\")}"`;
}
function plan(options: LinuxDesktopEntryOptions): Plan | null {
  if (options.platform !== "linux" || !options.appImage) return null;
  const appImagePath = absolutePath(options.appImage);
  // The Desktop Entry specification forbids '=' in the executable program name.
  if (appImagePath.includes("=")) throw new Error("Unsupported AppImage executable path");
  const image = stat(appImagePath);
  if (!image?.isFile()) throw new Error("AppImage path must identify a regular non-symlink file");
  const home = absolutePath(options.homeDirectory);
  if (options.xdgDataHome && /[\x00-\x1f\x7f-\x9f]/u.test(options.xdgDataHome)) throw new Error("Unsafe XDG data path");
  const dataHome = options.xdgDataHome && isAbsolute(options.xdgDataHome)
    ? absolutePath(options.xdgDataHome) : join(home, ".local", "share");
  const desktopPath = join(dataHome, "applications", `${APP_ID}.desktop`);
  const iconPath = join(absolutePath(options.userDataDirectory), "linux-desktop-icon.png");
  safeDirectories(dirname(desktopPath), false);
  safeDirectories(dirname(iconPath), false);
  const sourcePath = absolutePath(options.iconSourcePath);
  const icon = regularFile(sourcePath, 2 * 1024 * 1024);
  if (!icon || !icon.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) throw new Error("Canonical desktop icon must be a PNG file");
  const previousIcon = regularFile(iconPath, 2 * 1024 * 1024);
  if (previousIcon && !previousIcon.equals(icon)) throw new Error("Refusing to overwrite a foreign desktop icon");
  const suffix = `Icon=${value(iconPath)}\nTerminal=false\nStartupWMClass=${APP_ID}\nCategories=Network;Chat;\n`;
  const entry = `${HEADER}Exec=${executable(appImagePath)}\n${suffix}`;
  const previous = regularFile(desktopPath, 32 * 1024);
  if (previous) {
    const text = previous.toString("utf8");
    const execLine = text.slice(HEADER.length, text.length - suffix.length).replaceAll("\\\\", "\\");
    if (!text.startsWith(HEADER) || !text.endsWith(suffix) || !/^Exec="(?:[^"\\\n\r]|\\["\\$`])*"\n$/u.test(execLine)) {
      throw new Error("Refusing to overwrite a foreign or unowned desktop entry");
    }
  }
  const status = previous ? previous.equals(Buffer.from(entry)) && previousIcon ? "current" : "update" : "missing";
  return { description: { desktopPath, iconPath, appImagePath, status }, entry, previous, icon };
}

/** Read-only inspection. Invalid/foreign paths fail closed; unsupported launch types return null. */
export function describeLinuxDesktopEntry(options: LinuxDesktopEntryOptions): LinuxDesktopEntryDescription | null {
  return plan(options)?.description ?? null;
}
function sameFile(actual: Stats | null, expected: Stats): boolean {
  return actual !== null && actual.isFile() && actual.ino === expected.ino && actual.dev === expected.dev;
}
function writeFile(path: string, contents: Buffer, previous: Buffer | null): void {
  const parent = dirname(path);
  safeDirectories(parent, false);
  const resolvedParent = realpathSync(parent);
  const expected = stat(path);
  const prefix = `.${basename(path)}.chat-`;
  const temporary = join(parent, `${prefix}${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let opened: Stats | null = null;
  let closed = false;
  try {
    opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error("Unsafe desktop integration staging file");
    // A failed write/fsync must never publish partial bytes or damage a working launcher.
    let offset = 0;
    while (offset < contents.length) {
      const written = writeSync(descriptor, contents, offset, contents.length - offset, offset);
      if (written === 0) throw new Error("Desktop integration file write failed");
      offset += written;
    }
    fsyncSync(descriptor);
    closed = true;
    closeSync(descriptor);
    safeDirectories(parent, false);
    const staged = stat(temporary);
    if (realpathSync(parent) !== resolvedParent || !sameFile(staged, opened) || staged?.nlink !== 1 || staged.size !== contents.length) {
      throw new Error("Desktop integration staging file changed during registration");
    }
    if (previous === null) {
      // Unlike rename, link atomically refuses any newly appeared destination, including symlinks.
      linkSync(temporary, path);
    } else {
      const current = regularFile(path, 32 * 1024);
      const latest = stat(path);
      if (!expected || !sameFile(latest, expected) || latest?.nlink !== 1 || !current?.equals(previous)) {
        throw new Error("Desktop integration target is no longer a safe owned file");
      }
      renameSync(temporary, path);
    }
  } finally {
    try { if (!closed) closeSync(descriptor); } finally {
      // Never remove a destination or a substituted temp: only our inode under the intended parent/prefix.
      if (opened && resolve(temporary) !== resolve(path) && dirname(resolve(temporary)) === parent
        && basename(temporary).startsWith(prefix) && realpathSync(parent) === resolvedParent) {
        const remaining = stat(temporary);
        if (sameFile(remaining, opened)) unlinkSync(temporary);
      }
    }
  }
}

/** Call from a native consent flow (startup or menu), never from renderer-controlled input. No launcher is executed. */
export async function ensureLinuxDesktopEntry(
  options: LinuxDesktopEntryOptions,
  consent: (description: LinuxDesktopEntryDescription) => Promise<boolean>,
): Promise<LinuxDesktopEntryResult> {
  const snapshot = { ...options };
  const initial = plan(snapshot);
  if (!initial) return "unsupported";
  if (initial.description.status === "current") return "unchanged";
  if (await consent({ ...initial.description }) !== true) return "declined";
  const approved = plan(snapshot);
  if (!approved || approved.entry !== initial.entry || !approved.icon.equals(initial.icon)
    || (initial.previous === null ? approved.previous !== null : !approved.previous?.equals(initial.previous))) {
    throw new Error("Desktop integration files changed during consent; request fresh consent");
  }
  const { desktopPath, iconPath } = approved.description;
  safeDirectories(dirname(iconPath), true);
  safeDirectories(dirname(desktopPath), true);
  const currentIcon = regularFile(iconPath, 2 * 1024 * 1024);
  if (currentIcon && !currentIcon.equals(approved.icon)) throw new Error("Desktop icon changed during registration");
  if (!currentIcon) writeFile(iconPath, approved.icon, null);
  writeFile(desktopPath, Buffer.from(approved.entry), approved.previous);
  return "registered";
}
