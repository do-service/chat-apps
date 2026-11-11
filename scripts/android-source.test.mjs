import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportSource } from "./android-source.mjs";

const remote = "https://gitlab.exz-vps.ru/fullstack/chat.git";
const script = fileURLToPath(new URL("./android-source.mjs", import.meta.url));
const fakeCredentials = { GITLAB_READ_USERNAME: "fixture-user", GITLAB_READ_TOKEN: "fixture-token-never-real" };

function git(args, options = {}) {
  const result = spawnSync("git", args, { timeout: 10000, maxBuffer: 40 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

async function fixture(t, { filter = true, extra = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "android-source-test-"));
  const identity = await lstat(root);
  t.after(async () => {
    const current = await lstat(root);
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("android-source-test-"));
    assert.equal(current.ino, identity.ino);
    assert.equal(current.dev, identity.dev);
    await rm(root, { recursive: true });
  });
  const repo = path.join(root, "origin");
  const home = path.join(root, "fixture-home");
  await mkdir(repo);
  await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" };
  const local = (args, input) => git(["-C", repo, ...args], { env, input });
  local(["init", "--initial-branch=main", "--template="]);
  local(["config", "user.name", "Fixture"]);
  local(["config", "user.email", "fixture@example.invalid"]);
  local(["config", "uploadpack.allowFilter", String(filter)]);
  local(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const files = {
    "frontend/package.json": '{"private":true}\n',
    "frontend/src/main.js": 'console.log("fixture");\n',
    "mobile/package.json": '{"name":"mobile"}\n',
    "mobile/android/gradlew": "#!/bin/sh\nexit 0\n",
    "backend/private.txt": "FICTIONAL BACKEND MUST NOT BE EXPORTED\n",
    ".gitattributes": "* filter=never-run export-ignore\n",
    "README.md": "not selected\n",
    ...extra,
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), bytes);
  }
  await chmod(path.join(repo, "mobile/android/gradlew"), 0o755);
  local(["add", "."]);
  local(["commit", "-m", "first"]);
  await writeFile(path.join(repo, "backend/older.txt"), "fictional history\n");
  local(["add", "."]);
  local(["commit", "-m", "tip"]);
  const sha = local(["rev-parse", "HEAD"]).toString().trim();
  const dest = path.join(root, "export");
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    assert.equal(args.some((arg) => /fixture-user|fixture-token/.test(arg)), false);
    assert.equal(options.env.GIT_TRACE, undefined);
    assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(options.env.GIT_SSL_NO_VERIFY, undefined);
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
    assert.ok(options.timeout > 0 && options.timeout <= 60000);
    assert.ok(options.maxBuffer <= 17 * 1024 * 1024);
    assert.ok(args.includes("http.followRedirects=false"));
    assert.ok(args.includes("http.sslVerify=true"));
    assert.ok(args.includes("credential.helper="));
    assert.ok(args.includes("protocol.version=2"));
    const network = args.includes("ls-remote") || args.includes("clone") || args.includes("fetch");
    assert.equal(options.env.GITLAB_READ_TOKEN, network ? fakeCredentials.GITLAB_READ_TOKEN : undefined);
    if (network) {
      const askpass = await readFile(options.env.GIT_ASKPASS, "utf8");
      assert.ok(askpass.includes("$GITLAB_READ_TOKEN"));
      assert.ok(askpass.includes("$GITLAB_READ_USERNAME"));
      assert.equal(askpass.includes(fakeCredentials.GITLAB_READ_TOKEN), false);
    }
    const mapped = args.map((arg) => arg === remote ? `file://${repo}` : arg);
    if (network) mapped.unshift("-c", "protocol.file.allow=always");
    const result = spawnSync("git", mapped, options);
    if (result.error || result.status !== 0) {
      t.diagnostic(`Local fixture Git failed: ${result.stderr}`);
      throw new Error("Local fixture Git failed");
    }
    return result.stdout;
  };
  return { root, repo, local, dest, sha, env: { ...fakeCredentials, EXPECTED_SOURCE_SHA: sha }, calls, run, files };
}

async function assertNoExport(f) {
  await assert.rejects(lstat(f.dest), { code: "ENOENT" });
  assert.deepEqual((await readdir(f.root)).sort(), ["fixture-home", "origin"]);
}

test("stock Git exports only selected blobs, one tip commit, no checkout or attribute fetch", async (t) => {
  const f = await fixture(t);
  const result = await exportSource(f.dest, { env: f.env, run: f.run });
  assert.deepEqual(Object.keys(result).sort(), ["filecount", "sourceCommit", "sourceTreeSha256"]);
  assert.equal(result.sourceCommit, f.sha);
  assert.equal(result.filecount, 4);
  assert.deepEqual((await readdir(f.dest)).sort(), ["frontend", "mobile"]);
  for (const [name, bytes] of Object.entries(f.files).filter(([name]) => /^(frontend|mobile)\//.test(name))) {
    assert.equal(await readFile(path.join(f.dest, name), "utf8"), bytes);
  }
  assert.ok((await lstat(path.join(f.dest, "mobile/android/gradlew"))).mode & 0o100);
  const entries = f.local(["ls-tree", "-r", "-l", f.sha, "--", "frontend/", "mobile/"]).toString().trimEnd().split("\n");
  const manifest = entries.map((line) => {
    const [, mode, oid, size, name] = /^(\d+) blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
    return `${mode} ${oid} ${size}\t${name}\n`;
  }).join("");
  assert.equal(result.sourceTreeSha256, createHash("sha256").update(manifest).digest("hex"));
  const clone = f.calls.find(({ args }) => args.includes("clone")).args;
  for (const option of ["--no-checkout", "--filter=blob:none", "--depth=1", "--single-branch", "--no-tags", "--template="]) assert.ok(clone.includes(option));
  const tree = f.calls.find(({ args }) => args.includes("ls-tree")).args;
  assert.equal(tree.includes("-l"), false, "size lookup must not trigger lazy fetching before allowlist approval");
  assert.deepEqual(tree.slice(tree.indexOf("--") + 1), ["frontend/", "mobile/"]);
  assert.equal(f.calls.some(({ args }) => args.includes("checkout") || args.includes("archive")), false);
  const fetch = f.calls.find(({ args }) => args.includes("fetch"));
  const selected = f.local(["ls-tree", "-r", f.sha, "--", "frontend/", "mobile/"]).toString().trimEnd().split("\n").map((line) => line.split(/\s+/)[2]);
  assert.deepEqual(fetch.options.input.toString().trimEnd().split("\n").sort(), [...new Set(selected)].sort());
  assert.deepEqual((await readdir(f.root)).sort(), ["export", "fixture-home", "origin"]);
  for (const call of f.calls) await assert.rejects(lstat(call.options.env.HOME), { code: "ENOENT" });
});

test("stock Git credential fill uses controlled askpass without terminal prompts", async (t) => {
  const f = await fixture(t);
  const fills = [];
  let noAskpass;
  const alternate = { GITLAB_READ_USERNAME: "alternate-fixture-user", GITLAB_READ_TOKEN: "alternate-fixture-token" };
  const run = async (args, options) => {
    if (args.includes("ls-remote")) {
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      const config = args.slice(0, args.indexOf("ls-remote"));
      assert.ok(config.includes("credential.helper="));
      for (const credentials of [fakeCredentials, alternate]) {
        const result = spawnSync("git", [...config, "credential", "fill"], {
          ...options,
          env: { ...options.env, ...credentials },
          input: "protocol=https\nhost=gitlab.exz-vps.ru\npath=fullstack/chat.git\n\n",
          timeout: 5000,
        });
        fills.push({ result, credentials });
        if (result.status !== 0) throw new Error("Controlled fixture askpass failed");
      }
      noAskpass = spawnSync("git", [...config, "credential", "fill"], {
        ...options,
        env: { ...options.env, GIT_ASKPASS: "/dev/null" },
        input: "protocol=https\nhost=gitlab.exz-vps.ru\npath=fullstack/chat.git\n\n",
        timeout: 5000,
      });
    }
    return f.run(args, options);
  };
  let failure;
  await exportSource(f.dest, { env: f.env, run }).catch((error) => { failure = error; });
  assert.ok(fills.length > 0);
  for (const { result, credentials } of fills) {
    assert.equal(result.status, 0, "Stock Git must allow controlled askpass with terminal prompting disabled");
    assert.equal(result.error, undefined);
    assert.equal(result.stderr.length, 0);
    const fields = Object.fromEntries(result.stdout.toString().trimEnd().split("\n").map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.equal(fields.username, credentials.GITLAB_READ_USERNAME);
    assert.equal(fields.password, credentials.GITLAB_READ_TOKEN);
  }
  assert.ifError(failure);
  assert.equal(fills.length, 2, "The same askpass script must use credentials from each child environment");
  assert.equal(noAskpass.error, undefined);
  assert.notEqual(noAskpass.status, 0, "Missing askpass must fail rather than fall back to terminal prompting");
  assert.match(noAskpass.stderr.toString(), /terminal prompts disabled/);
});

test("ordinary dotfiles, shared blobs and empty files are materialized without extra fetches", async (t) => {
  const f = await fixture(t, { extra: { "frontend/.gitignore": "node_modules\n", "mobile/.gitignore": "node_modules\n", "mobile/empty": "" } });
  const result = await exportSource(f.dest, { env: f.env, run: f.run });
  assert.equal(result.filecount, 7);
  assert.equal(await readFile(path.join(f.dest, "frontend/.gitignore"), "utf8"), "node_modules\n");
  assert.equal((await lstat(path.join(f.dest, "mobile/empty"))).size, 0);
});

test("native Git silent filter fallback with exit zero aborts before tree/content/export", async (t) => {
  const f = await fixture(t, { filter: false });
  await assert.rejects(exportSource(f.dest, { env: f.env, run: f.run }), /initial inventory/i);
  assert.ok(f.calls.some(({ args }) => args.includes("clone")));
  assert.equal(f.calls.some(({ args }) => args.includes("ls-tree") || args.includes("fetch")), false);
  await assertNoExport(f);
});

test("expected source SHA must be full hex and match the actual main tip", async (t) => {
  const f = await fixture(t);
  for (const sha of ["", "main", "a".repeat(39), "g".repeat(40), `${f.sha}\n`, "a".repeat(40)]) {
    await assert.rejects(exportSource(f.dest, { env: { ...f.env, EXPECTED_SOURCE_SHA: sha }, run: f.run }), /source SHA|main tip/i);
    await assertNoExport(f);
  }
});

test("absent or line-injected credentials reject before any Git command", async (t) => {
  const f = await fixture(t);
  for (const env of [{ ...f.env, GITLAB_READ_TOKEN: "" }, { ...f.env, GITLAB_READ_USERNAME: "" }, { ...f.env, GITLAB_READ_TOKEN: "fake\ninvalid" }]) {
    await assert.rejects(exportSource(f.dest, { env, run: f.run }), /credentials/i);
  }
  assert.equal(f.calls.length, 0);
  await assertNoExport(f);
});

test("an existing destination, including a symlink, is never overwritten or removed", async (t) => {
  const f = await fixture(t);
  await symlink(f.repo, f.dest);
  await assert.rejects(exportSource(f.dest, { env: f.env, run: f.run }), /destination/i);
  assert.ok((await lstat(f.dest)).isSymbolicLink());
  assert.equal(f.calls.length, 0);
});

for (const entry of [
  "120000 blob OID\tfrontend/link\0",
  "160000 commit OID\tfrontend/submodule\0",
  "100644 blob OID\tfrontend/../backend/private.txt\0",
  "100644 blob OID\tfrontend/.git/config\0",
  "100644 blob OID\tfrontend/bad\\path\0",
  "100644 blob OID\tfrontend/evil\nname\0",
  "100644 blob OID\tbackend/private.txt\0",
  "100644 blob OID\tfrontend/A.js\0" + "100644 blob OID\tfrontend/a.js\0",
  "100644 blob OID\tfrontend/nul.txt\0",
]) {
  test(`unsafe tree entry rejects without fetching or exporting: ${JSON.stringify(entry)}`, async (t) => {
    const f = await fixture(t);
    const oid = f.local(["rev-parse", `${f.sha}:frontend/package.json`]).toString().trim();
    const run = async (args, options) => args.includes("ls-tree") ? Buffer.from(entry.replaceAll("OID", oid)) : f.run(args, options);
    await assert.rejects(exportSource(f.dest, { env: f.env, run }), /tree|path|mode/i);
    assert.equal(f.calls.some(({ args }) => args.includes("fetch")), false);
    await assertNoExport(f);
  });
}

test("post-fetch inventory rejects an unsolicited backend blob before any materialization", async (t) => {
  const f = await fixture(t);
  let contentReads = 0;
  const run = async (args, options) => {
    const bytes = await f.run(args, options);
    if (args.includes("fetch")) git(["-C", options.cwd, "hash-object", "-w", "--stdin"], { env: options.env, input: "unsolicited fictional backend" });
    if (args.includes("blob")) contentReads++;
    return bytes;
  };
  await assert.rejects(exportSource(f.dest, { env: f.env, run }), /final inventory/i);
  assert.equal(contentReads, 0);
  await assertNoExport(f);
});

test("post-fetch inventory rejects another commit even if its blobs were not sent", async (t) => {
  const f = await fixture(t);
  const parent = f.local(["cat-file", "commit", `${f.sha}^`]);
  const run = async (args, options) => {
    const bytes = await f.run(args, options);
    if (args.includes("fetch")) git(["-C", options.cwd, "hash-object", "-w", "-t", "commit", "--stdin"], { env: options.env, input: parent });
    return bytes;
  };
  await assert.rejects(exportSource(f.dest, { env: f.env, run }), /final inventory/i);
  await assertNoExport(f);
});

test("Git LFS pointer is never exported and all temporary data is removed", async (t) => {
  const f = await fixture(t, { extra: { "mobile/pointer": `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 123\n` } });
  await assert.rejects(exportSource(f.dest, { env: f.env, run: f.run }), /LFS/i);
  await assertNoExport(f);
});

test("oversized blob and excessive file count abort before content reads", async (t) => {
  const f = await fixture(t);
  let inventories = 0;
  const run = async (args, options) => {
    const bytes = await f.run(args, options);
    if (args.includes("--batch-all-objects") && ++inventories === 2) return Buffer.from(bytes.toString().replace(/blob \d+/, "blob 999999999"));
    return bytes;
  };
  await assert.rejects(exportSource(f.dest, { env: f.env, run }), /size|limit/i);
  await assertNoExport(f);
  const oid = f.local(["rev-parse", `${f.sha}:frontend/package.json`]).toString().trim();
  const tooMany = async (args, options) => args.includes("ls-tree") ? Buffer.from(Array.from({ length: 10001 }, (_, i) => `100644 blob ${oid}\tfrontend/file${i}\0`).join("")) : f.run(args, options);
  await assert.rejects(exportSource(f.dest, { env: f.env, run: tooMany }), /file|limit/i);
  await assertNoExport(f);
});

test("hostile inherited Git config/traces/proxies and diagnostics cannot leak secrets", async (t) => {
  const f = await fixture(t);
  const env = { ...f.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.sslVerify", GIT_CONFIG_VALUE_0: "false", GIT_TRACE: path.join(f.root, "trace"), GIT_DIR: f.repo, GIT_SSL_NO_VERIFY: "1", HTTPS_PROXY: "https://user:password@example.invalid", GITHUB_ENV: path.join(f.root, "github-env") };
  const run = async (args, options) => {
    assert.equal(options.env.HTTPS_PROXY, undefined);
    await f.run(args, options);
    throw new Error(`raw transport output ${fakeCredentials.GITLAB_READ_TOKEN} ${fakeCredentials.GITLAB_READ_USERNAME}`);
  };
  await assert.rejects(exportSource(f.dest, { env, run }), (error) => {
    assert.equal(error.message.includes(fakeCredentials.GITLAB_READ_TOKEN), false);
    assert.equal(error.message.includes("raw transport output"), false);
    return true;
  });
  await assertNoExport(f);
});

test("invalid inventory, missing approved blobs, malformed encoding and corrupt content fail closed", async (t) => {
  const f = await fixture(t);
  const mutations = [
    { phase: 1, change: (bytes) => Buffer.from(bytes.toString() + `${"a".repeat(40)} tag 10\n`) },
    { phase: 1, change: (bytes) => Buffer.from(bytes.toString() + bytes.toString().split("\n")[0] + "\n") },
    { phase: 1, change: () => Buffer.from([255]) },
    { phase: 1, change: (bytes) => Buffer.from(bytes.toString().replace(/ tree \d+/, " tree 999999999999999999999")) },
    { phase: 1, change: (bytes) => Buffer.from(bytes.toString().replace(/^.* commit .*\n/m, "")) },
    { phase: 2, change: (bytes) => Buffer.from(bytes.toString().replace(/^.* blob .*\n/m, "")) },
    { phase: 2, change: (bytes) => Buffer.from(bytes.toString() + `${"a".repeat(40)} tree 5\n`) },
    { phase: 2, change: (bytes) => Buffer.from(bytes.toString().replace(/ tree \d+/, " tree 1")) },
  ];
  for (const { phase, change } of mutations) {
    let count = 0;
    const run = async (args, options) => {
      const bytes = await f.run(args, options);
      return args.includes("--batch-all-objects") && ++count === phase ? change(bytes) : bytes;
    };
    await assert.rejects(exportSource(f.dest, { env: f.env, run }), /inventory|metadata|size|encoding/i);
    await assertNoExport(f);
  }
  const corrupt = async (args, options) => {
    const bytes = await f.run(args, options);
    if (!args.includes("blob")) return bytes;
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    return changed;
  };
  await assert.rejects(exportSource(f.dest, { env: f.env, run: corrupt }), /integrity/i);
  await assertNoExport(f);
});

test("malformed, duplicate and overlapping tree paths cannot be materialized", async (t) => {
  const f = await fixture(t);
  const oid = f.local(["rev-parse", `${f.sha}:frontend/package.json`]).toString().trim();
  for (const names of [["frontend/a", "frontend/a"], ["frontend/a", "frontend/a/b"], ["frontend/a"], ["frontend/A/a", "frontend/a/b"], ["frontend//a"], ["frontend/a."]]) {
    const run = async (args, options) => args.includes("ls-tree") ? Buffer.from(names.map((name) => `100644 blob ${oid}\t${name}\0`).join("")) : f.run(args, options);
    await assert.rejects(exportSource(f.dest, { env: f.env, run }), /tree|path/i);
    await assertNoExport(f);
  }
  for (const value of [Buffer.from(""), Buffer.from("100644 blob broken"), "not a buffer", Buffer.alloc(17 * 1024 * 1024)]) {
    const run = async (args, options) => args.includes("ls-tree") ? value : f.run(args, options);
    await assert.rejects(exportSource(f.dest, { env: f.env, run }), /tree|output/i);
    await assertNoExport(f);
  }
});

test("deadline expiration is bounded and cleanup completes without source export", async (t) => {
  const f = await fixture(t);
  const original = Date.now;
  let time = original();
  Date.now = () => time;
  try {
    const run = async (args, options) => {
      const bytes = await f.run(args, options);
      time += 300001;
      return bytes;
    };
    await assert.rejects(exportSource(f.dest, { env: f.env, run }), /time limit/i);
  } finally {
    Date.now = original;
  }
  await assertNoExport(f);
});

test("CLI stock runner emits exactly one JSON result through an injected local-only executable", async (t) => {
  const f = await fixture(t);
  let realGit;
  for (const directory of process.env.PATH.split(path.delimiter)) {
    try { realGit = await realpath(path.join(directory, "git")); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  assert.ok(realGit);
  const bin = path.join(f.root, "bin");
  await mkdir(bin);
  const wrapper = path.join(bin, "git");
  await writeFile(wrapper, `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2).map(arg => arg === ${JSON.stringify(remote)} ? ${JSON.stringify(`file://${f.repo}`)} : arg);\nif (args.includes("clone") || args.includes("fetch") || args.includes("ls-remote")) args.unshift("-c", "protocol.file.allow=always");\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: "inherit", timeout: 10000 });\nprocess.exit(result.status === 0 ? 0 : 1);\n`, { mode: 0o700 });
  const githubEnv = path.join(f.root, "github-env");
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...f.env, GITHUB_ENV: githubEnv, GIT_TRACE: path.join(f.root, "trace") };
  const result = spawnSync(process.execPath, [script, f.dest], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.split("\n").length, 2);
  assert.equal(JSON.parse(result.stdout).sourceCommit, f.sha);
  await assert.rejects(lstat(githubEnv), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.root, "trace")), { code: "ENOENT" });
  await writeFile(wrapper, "#!/bin/sh\nprintf '%s' \"$GITLAB_READ_TOKEN\" >&2\nexit 1\n", { mode: 0o700 });
  const failed = spawnSync(process.execPath, [script, path.join(f.root, "failed-export")], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr.includes(fakeCredentials.GITLAB_READ_TOKEN), false);
  await assert.rejects(lstat(path.join(f.root, "failed-export")), { code: "ENOENT" });
  assert.equal((await readdir(f.root)).some((name) => name.startsWith(".android-source-")), false);
});

test("CLI errors are sanitized, stdout stays empty, and GITHUB_ENV is untouched", async (t) => {
  const f = await fixture(t);
  const githubEnv = path.join(f.root, "github-env");
  const result = spawnSync(process.execPath, [script, f.dest], { env: { PATH: process.env.PATH, ...f.env, EXPECTED_SOURCE_SHA: "invalid", GITHUB_ENV: githubEnv }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /source SHA/i);
  assert.equal(result.stderr.includes(fakeCredentials.GITLAB_READ_TOKEN), false);
  await assertNoExport(f);
});
