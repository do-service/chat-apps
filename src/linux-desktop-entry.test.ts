import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as pathModule from "node:path";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import * as contract from "./contract";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, linkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { APP_ID } from "./contract";
import { describeLinuxDesktopEntry, ensureLinuxDesktopEntry, type LinuxDesktopEntryOptions } from "./linux-desktop-entry";

// These fixtures exercise POSIX filenames and symlink semantics; Windows never registers Linux entries.
const linuxTest = process.platform === "win32" ? test.skip : test;
const png = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
function fixture() {
  const root = realpathSync(tmpdir());
  const path = mkdtempSync(join(root, "chat-linux-desktop-"));
  const options: LinuxDesktopEntryOptions = {
    platform: "linux", appImage: join(path, "Chat.AppImage"), homeDirectory: join(path, "home"),
    userDataDirectory: join(path, "profile"), iconSourcePath: join(path, "mounted-icon.png"),
    xdgDataHome: join(path, "xdg"),
  };
  writeFileSync(options.appImage ?? "", "AppImage fixture");
  writeFileSync(options.iconSourcePath, png);
  return { path, options, cleanup: () => {
    assert.equal(dirname(realpathSync(path)), root);
    assert.ok(basename(path).startsWith("chat-linux-desktop-"));
    rmSync(path, { recursive: true });
  } };
}

// Compile in memory so injected failures never mutate node:fs or the public helper API.
const compiledHelper = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/linux-desktop-entry.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiledHelper.status, 0, compiledHelper.stderr);
const helperSource = compiledHelper.stdout;
function injectedHelper(overrides: object) {
  const module = { exports: { ensureLinuxDesktopEntry, describeLinuxDesktopEntry } };
  runInNewContext(helperSource, {
    module, exports: module.exports, Buffer, Error,
    require: (name: string) => {
      if (name === "node:fs") return { ...fs, ...overrides };
      if (name === "node:path") return pathModule;
      if (name === "node:crypto") return crypto;
      if (name === "./contract") return contract;
      throw new Error(`Unexpected helper import: ${name}`);
    },
  });
  return module.exports;
}

for (const target of ["icon", "desktop"]) {
  for (const failure of ["write", "fsync"]) {
    for (const update of [false, true]) {
      linuxTest(`${target} ${failure} failure ${update ? "during update preserves the working entry" : "never publishes a partial new file"} and permits retry`, async () => {
        const temp = fixture();
        try {
          if (update) await ensureLinuxDesktopEntry(temp.options, async () => true);
          const description = describeLinuxDesktopEntry(temp.options);
          assert.ok(description);
          const original = update ? readFileSync(description.desktopPath) : null;
          const options = update ? { ...temp.options, appImage: join(temp.path, "Moved.AppImage") } : temp.options;
          if (update) writeFileSync(options.appImage ?? "", "moved fixture");
          // An update with a missing icon must also leave the working entry intact on icon failure.
          if (update && target === "icon") {
            assert.equal(dirname(realpathSync(description.iconPath)), realpathSync(temp.options.userDataDirectory));
            assert.equal(basename(description.iconPath), "linux-desktop-icon.png");
            fs.unlinkSync(description.iconPath);
          }
          const descriptors = new Set<number>();
          const helper = injectedHelper({
            writeSync: (fd: number, data: Buffer, offset: number, length: number, position: number) => {
              if (data.equals(png) === (target === "icon")) {
                descriptors.add(fd);
                if (failure === "write") {
                  if (offset > 0) throw new Error("Injected EIO after partial write");
                  return fs.writeSync(fd, data, offset, Math.min(length, target === "icon" ? 7 : update ? 250 : 30), position);
                }
              }
              return fs.writeSync(fd, data, offset, length, position);
            },
            fsyncSync: (fd: number) => {
              if (failure === "fsync" && descriptors.has(fd)) throw new Error("Injected EIO during fsync");
              fs.fsyncSync(fd);
            },
          });
          await assert.rejects(helper.ensureLinuxDesktopEntry(options, async () => true), /Injected EIO/);
          if (original) assert.deepEqual(readFileSync(description.desktopPath), original);
          else assert.equal(existsSync(description.desktopPath), false);
          if (target === "icon") assert.equal(existsSync(description.iconPath), false);
          assert.deepEqual(readdirSync(dirname(description.desktopPath)), original ? [basename(description.desktopPath)] : []);
          assert.deepEqual(readdirSync(dirname(description.iconPath)), existsSync(description.iconPath) ? [basename(description.iconPath)] : []);
          assert.equal(await ensureLinuxDesktopEntry(options, async () => true), "registered");
          assert.equal(describeLinuxDesktopEntry(options)?.status, "current");
        } finally { temp.cleanup(); }
      });
    }
  }
}

for (const target of ["icon", "desktop"]) {
  linuxTest(`new ${target} publication never clobbers a replacement appearing after staging`, async () => {
    const temp = fixture();
    try {
      const description = describeLinuxDesktopEntry(temp.options);
      assert.ok(description);
      const destination = target === "icon" ? description.iconPath : description.desktopPath;
      const helper = injectedHelper({
        linkSync: (source: string, path: string) => {
          // Race at the publication syscall, after every userspace absence check.
          if (path === destination) writeFileSync(destination, "race replacement");
          fs.linkSync(source, path);
        },
      });
      await assert.rejects(helper.ensureLinuxDesktopEntry(temp.options, async () => true));
      assert.equal(readFileSync(destination, "utf8"), "race replacement");
    } finally { temp.cleanup(); }
  });
}

for (const replacement of ["bytes", "inode", "symlink", "hardlink"]) {
  linuxTest(`existing entry ${replacement} change while staging is rejected before rename`, async () => {
    const temp = fixture();
    try {
      await ensureLinuxDesktopEntry(temp.options, async () => true);
      const description = describeLinuxDesktopEntry(temp.options);
      assert.ok(description);
      const original = readFileSync(description.desktopPath);
      const moved = { ...temp.options, appImage: join(temp.path, "Moved.AppImage") };
      writeFileSync(moved.appImage, "moved fixture");
      const victim = join(temp.path, "replacement");
      writeFileSync(victim, replacement === "inode" ? original : Buffer.from("foreign replacement"));
      const helper = injectedHelper({
        fsyncSync: (fd: number) => {
          fs.fsyncSync(fd);
          if (replacement === "bytes") writeFileSync(description.desktopPath, "foreign replacement");
          else if (replacement === "inode") fs.renameSync(victim, description.desktopPath);
          else if (replacement === "symlink") {
            assert.equal(dirname(realpathSync(description.desktopPath)), realpathSync(dirname(description.desktopPath)));
            assert.equal(basename(description.desktopPath), `${APP_ID}.desktop`);
            fs.unlinkSync(description.desktopPath);
            symlinkSync(victim, description.desktopPath);
          } else linkSync(description.desktopPath, join(temp.path, "hardlink"));
        },
      });
      await assert.rejects(helper.ensureLinuxDesktopEntry(moved, async () => true), /changed|safe|owned/i);
      assert.deepEqual(readFileSync(description.desktopPath), replacement === "bytes" || replacement === "symlink" ? Buffer.from("foreign replacement") : original);
      if (replacement === "symlink") assert.equal(lstatSync(description.desktopPath).isSymbolicLink(), true);
      assert.deepEqual(readdirSync(dirname(description.desktopPath)), [basename(description.desktopPath)]);
    } finally { temp.cleanup(); }
  });
}

linuxTest("cleanup preserves a foreign replacement of the staging pathname", async () => {
  const temp = fixture();
  try {
    const description = describeLinuxDesktopEntry(temp.options);
    assert.ok(description);
    let substituted = "";
    const helper = injectedHelper({
      fsyncSync: (fd: number) => {
        fs.fsyncSync(fd);
        const names = readdirSync(temp.options.userDataDirectory);
        const name = names.find((item) => item.startsWith(".linux-desktop-icon.png.chat-") && item.endsWith(".tmp"));
        assert.ok(name);
        substituted = join(temp.options.userDataDirectory, name);
        assert.equal(dirname(realpathSync(substituted)), realpathSync(temp.options.userDataDirectory));
        assert.equal(lstatSync(substituted).ino, fs.fstatSync(fd).ino);
        fs.renameSync(substituted, join(temp.path, "displaced-stage"));
        writeFileSync(substituted, "foreign temporary replacement");
      },
    });
    await assert.rejects(helper.ensureLinuxDesktopEntry(temp.options, async () => true), /staging file changed/);
    assert.equal(readFileSync(substituted, "utf8"), "foreign temporary replacement");
    assert.equal(existsSync(description.iconPath), false);
    assert.equal(existsSync(description.desktopPath), false);
    assert.equal(await ensureLinuxDesktopEntry(temp.options, async () => true), "registered");
  } finally { temp.cleanup(); }
});

linuxTest("truncated owned headers are never accepted as repairable entries", async () => {
  const temp = fixture();
  try {
    await ensureLinuxDesktopEntry(temp.options, async () => true);
    const description = describeLinuxDesktopEntry(temp.options);
    assert.ok(description);
    const original = readFileSync(description.desktopPath);
    for (const length of [30, 100, original.length - 1]) {
      const malformed = original.subarray(0, length);
      writeFileSync(description.desktopPath, malformed);
      await assert.rejects(ensureLinuxDesktopEntry(temp.options, async () => { throw new Error("Unexpected consent"); }), /foreign|unowned/);
      assert.deepEqual(readFileSync(description.desktopPath), malformed);
    }
  } finally { temp.cleanup(); }
});

linuxTest("description is read-only and resolves the fixed desktop ID and stable own icon", () => {
  const temp = fixture();
  try {
    const description = describeLinuxDesktopEntry(temp.options);
    assert.ok(description);
    assert.equal(description.desktopPath, join(temp.path, "xdg", "applications", `${APP_ID}.desktop`));
    assert.equal(description.iconPath, join(temp.options.userDataDirectory, "linux-desktop-icon.png"));
    assert.equal(description.appImagePath, temp.options.appImage);
    assert.equal(description.status, "missing");
    assert.deepEqual(readdirSync(temp.path).sort(), ["Chat.AppImage", "mounted-icon.png"]);
    for (const xdgDataHome of [undefined, "", "relative/data"]) {
      assert.equal(describeLinuxDesktopEntry({ ...temp.options, xdgDataHome })?.desktopPath,
        join(temp.options.homeDirectory, ".local", "share", "applications", `${APP_ID}.desktop`));
    }
  } finally { temp.cleanup(); }
});

linuxTest("unsupported launches do not inspect paths or ask consent", async () => {
  const temp = fixture();
  try {
    for (const options of [{ ...temp.options, platform: "darwin" }, { ...temp.options, appImage: undefined }]) {
      assert.equal(describeLinuxDesktopEntry(options), null);
      assert.equal(await ensureLinuxDesktopEntry(options, async () => { throw new Error("Unexpected prompt"); }), "unsupported");
    }
  } finally { temp.cleanup(); }
});

linuxTest("cancel and consent rejection leave all registration paths absent", async () => {
  const temp = fixture();
  try {
    let prompts = 0;
    assert.equal(await ensureLinuxDesktopEntry(temp.options, async (description) => {
      prompts += 1;
      assert.equal(description.status, "missing");
      assert.equal(existsSync(dirname(description.desktopPath)), false);
      return false;
    }), "declined");
    assert.equal(prompts, 1);
    await assert.rejects(ensureLinuxDesktopEntry(temp.options, async () => { throw new Error("Dialog closed"); }), /Dialog closed/);
    assert.deepEqual(readdirSync(temp.path).sort(), ["Chat.AppImage", "mounted-icon.png"]);
  } finally { temp.cleanup(); }
});

linuxTest("consent registers a canonical PNG copy and an idempotent launcher, never a mounted icon reference", async () => {
  const temp = fixture();
  try {
    assert.equal(await ensureLinuxDesktopEntry(temp.options, async () => true), "registered");
    const description = describeLinuxDesktopEntry(temp.options);
    assert.ok(description);
    assert.equal(description.status, "current");
    assert.deepEqual(readFileSync(description.iconPath), png);
    const entry = readFileSync(description.desktopPath, "utf8");
    assert.match(entry, /^\[Desktop Entry\]\n/);
    assert.match(entry, /^X-Chat-Desktop-Integration=1$/m);
    assert.ok(entry.includes(`StartupWMClass=${APP_ID}\n`));
    assert.ok(entry.includes(`Exec="${temp.options.appImage}"\n`));
    assert.ok(entry.includes(`Icon=${description.iconPath}\n`));
    assert.ok(!entry.includes(temp.options.iconSourcePath));
    assert.ok(!entry.includes("%U"));
    for (const path of [description.desktopPath, description.iconPath]) {
      assert.equal(lstatSync(path).isFile(), true);
      assert.equal(lstatSync(path).nlink, 1);
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
    }
    assert.equal(await ensureLinuxDesktopEntry(temp.options, async () => { throw new Error("Unexpected prompt"); }), "unchanged");
    assert.equal(readFileSync(description.desktopPath, "utf8"), entry);
  } finally { temp.cleanup(); }
});

linuxTest("moved AppImages update only an owned versioned entry after fresh consent", async () => {
  const temp = fixture();
  try {
    await ensureLinuxDesktopEntry(temp.options, async () => true);
    const before = describeLinuxDesktopEntry(temp.options);
    assert.ok(before);
    const original = readFileSync(before.desktopPath, "utf8");
    const moved = { ...temp.options, appImage: join(temp.path, "Moved.AppImage") };
    writeFileSync(moved.appImage, "moved fixture");
    assert.equal(describeLinuxDesktopEntry(moved)?.status, "update");
    assert.equal(await ensureLinuxDesktopEntry(moved, async () => false), "declined");
    assert.equal(readFileSync(before.desktopPath, "utf8"), original);
    assert.equal(await ensureLinuxDesktopEntry(moved, async () => true), "registered");
    assert.ok(readFileSync(before.desktopPath, "utf8").includes(`Exec="${moved.appImage}"\n`));
  } finally { temp.cleanup(); }
});

linuxTest("Exec quotes and both Desktop Entry escaping layers preserve adversarial literal paths", async () => {
  const temp = fixture();
  try {
    const filename = 'Chat "quoted" %f $HOME `cmd` \\ unicode-Я.AppImage';
    const options = { ...temp.options, appImage: join(temp.path, filename), userDataDirectory: join(temp.path, "profile \\ Я") };
    writeFileSync(options.appImage, "fixture");
    await ensureLinuxDesktopEntry(options, async () => true);
    const description = describeLinuxDesktopEntry(options);
    assert.ok(description);
    const entry = readFileSync(description.desktopPath, "utf8");
    const exec = entry.split("\n").find((line) => line.startsWith("Exec="));
    const slash = "\\";
    assert.equal(exec, `Exec="${temp.path}/Chat ${slash.repeat(2)}"quoted${slash.repeat(2)}" %%f ${slash.repeat(2)}$HOME ${slash.repeat(2)}\`cmd${slash.repeat(2)}\` ${slash.repeat(4)} unicode-Я.AppImage"`);
    assert.ok(entry.includes(`Icon=${temp.path}/profile\\s\\\\\\sЯ/linux-desktop-icon.png\n`));
  } finally { temp.cleanup(); }
});

linuxTest("invalid paths, controls, non-files and symlink AppImages fail before consent or writes", async () => {
  const temp = fixture();
  try {
    const directory = join(temp.path, "directory.AppImage"); mkdirSync(directory);
    const linked = join(temp.path, "linked.AppImage"); symlinkSync(temp.options.appImage ?? "", linked);
    const cases: LinuxDesktopEntryOptions[] = [
      { ...temp.options, appImage: "relative.AppImage" }, { ...temp.options, appImage: directory },
      { ...temp.options, appImage: linked }, { ...temp.options, appImage: join(temp.path, "missing.AppImage") },
      { ...temp.options, userDataDirectory: "relative" }, { ...temp.options, homeDirectory: "relative" },
      { ...temp.options, appImage: join(temp.path, "bad=exec.AppImage") },
      ...["\n", "\r", "\0", "\t", "\x7f"].flatMap((control) => [
        { ...temp.options, appImage: `${temp.options.appImage}${control}` },
        { ...temp.options, xdgDataHome: `${temp.path}/${control}` },
        { ...temp.options, xdgDataHome: `relative${control}` },
        { ...temp.options, iconSourcePath: `${temp.options.iconSourcePath}${control}` },
      ]),
    ];
    for (const options of cases) {
      await assert.rejects(ensureLinuxDesktopEntry(options, async () => { throw new Error("Unexpected prompt"); }), /path|file|AppImage/i);
    }
    assert.equal(existsSync(join(temp.path, "xdg")), false);
    assert.equal(existsSync(temp.options.userDataDirectory), false);
  } finally { temp.cleanup(); }
});

linuxTest("foreign entries, unknown ownership versions, symlinks and hardlinks are never overwritten", async () => {
  for (const kind of ["foreign", "version", "symlink", "hardlink", "directory"]) {
    const temp = fixture();
    try {
      const description = describeLinuxDesktopEntry(temp.options);
      assert.ok(description);
      mkdirSync(dirname(description.desktopPath), { recursive: true });
      const victim = join(temp.path, "victim"); writeFileSync(victim, "foreign data");
      if (kind === "version") {
        await ensureLinuxDesktopEntry(temp.options, async () => true);
        writeFileSync(description.desktopPath, readFileSync(description.desktopPath, "utf8").replace("X-Chat-Desktop-Integration=1", "X-Chat-Desktop-Integration=2"));
      } else if (kind === "symlink") symlinkSync(victim, description.desktopPath);
      else if (kind === "hardlink") linkSync(victim, description.desktopPath);
      else if (kind === "directory") mkdirSync(description.desktopPath);
      else writeFileSync(description.desktopPath, "[Desktop Entry]\nName=Other app\n");
      const original = kind === "directory" ? null : readFileSync(description.desktopPath, "utf8");
      await assert.rejects(ensureLinuxDesktopEntry(temp.options, async () => { throw new Error("Unexpected prompt"); }), /foreign|owned|safe|regular/i);
      if (original !== null) assert.equal(readFileSync(description.desktopPath, "utf8"), original);
      assert.equal(readFileSync(victim, "utf8"), "foreign data");
    } finally { temp.cleanup(); }
  }
});

linuxTest("symlink ancestors and pre-existing foreign icon files fail closed", async () => {
  for (const kind of ["xdg", "applications", "profile", "icon"]) {
    const temp = fixture();
    try {
      const description = describeLinuxDesktopEntry(temp.options);
      assert.ok(description);
      const victim = join(temp.path, "victim"); mkdirSync(victim);
      if (kind === "xdg") symlinkSync(victim, join(temp.path, "xdg"));
      if (kind === "applications") {
        mkdirSync(join(temp.path, "xdg")); symlinkSync(victim, dirname(description.desktopPath));
      }
      if (kind === "profile") symlinkSync(victim, temp.options.userDataDirectory);
      if (kind === "icon") {
        mkdirSync(temp.options.userDataDirectory); writeFileSync(description.iconPath, "foreign icon");
      }
      await assert.rejects(ensureLinuxDesktopEntry(temp.options, async () => true), /safe|icon|symlink/i);
      assert.deepEqual(readdirSync(victim), []);
      if (kind === "icon") assert.equal(readFileSync(description.iconPath, "utf8"), "foreign icon");
    } finally { temp.cleanup(); }
  }
});

linuxTest("invalid source icons fail without creating registration directories", async () => {
  const temp = fixture();
  try {
    writeFileSync(temp.options.iconSourcePath, "not PNG");
    await assert.rejects(ensureLinuxDesktopEntry(temp.options, async () => true), /PNG/);
    assert.equal(existsSync(join(temp.path, "xdg")), false);
    assert.equal(existsSync(temp.options.userDataDirectory), false);
  } finally { temp.cleanup(); }
});

linuxTest("owned entry changes during consent require fresh consent and preserve the newer launcher", async () => {
  const temp = fixture();
  try {
    await ensureLinuxDesktopEntry(temp.options, async () => true);
    const moved = { ...temp.options, appImage: join(temp.path, "Moved.AppImage") };
    writeFileSync(moved.appImage, "moved fixture");
    const description = describeLinuxDesktopEntry(moved);
    assert.ok(description);
    let newer = "";
    await assert.rejects(ensureLinuxDesktopEntry(moved, async () => {
      newer = readFileSync(description.desktopPath, "utf8").replace("Chat.AppImage", "Another.AppImage");
      writeFileSync(description.desktopPath, newer);
      return true;
    }), /changed during consent/);
    assert.equal(readFileSync(description.desktopPath, "utf8"), newer);
  } finally { temp.cleanup(); }
});

linuxTest("filesystem changes during native consent are revalidated without overwriting the replacement", async () => {
  const temp = fixture();
  try {
    const description = describeLinuxDesktopEntry(temp.options);
    assert.ok(description);
    await assert.rejects(ensureLinuxDesktopEntry(temp.options, async () => {
      mkdirSync(dirname(description.desktopPath), { recursive: true });
      writeFileSync(description.desktopPath, "foreign replacement");
      return true;
    }), /foreign|owned/i);
    assert.equal(readFileSync(description.desktopPath, "utf8"), "foreign replacement");
    assert.equal(existsSync(temp.options.userDataDirectory), false);
  } finally { temp.cleanup(); }
});
