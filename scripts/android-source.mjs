import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REMOTE = "https://gitlab.exz-vps.ru/fullstack/chat.git";
const MAX_FILES = 10000;
const MAX_OBJECTS = 50000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024 * 1024 + 1024;
const TOTAL_TIMEOUT_MS = 300000;
const COMMAND_TIMEOUT_MS = 60000;
const decoder = new TextDecoder("utf-8", { fatal: true });

class SourceError extends Error {}
const fail = (message) => { throw new SourceError(message); };

function stockGit(args, { input, timeout, maxBuffer, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { ...options, detached: true });
    const chunks = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    // Kill the whole owned Git process group, including HTTPS/index-pack children, on failure.
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The child may already have exited. */ }
      }
      reject(new SourceError("Source Git command failed or exceeded its limit"));
    };
    const timer = setTimeout(abort, timeout);
    child.once("error", abort);
    child.stdin.on("error", abort);
    child.stdout.on("data", (bytes) => {
      stdoutSize += bytes.length;
      if (stdoutSize > maxBuffer) abort();
      else chunks.push(bytes);
    });
    // Consume but never log or retain credential-bearing diagnostics; bound them as well.
    child.stderr.on("data", (bytes) => {
      stderrSize += bytes.length;
      if (stderrSize > maxBuffer) abort();
    });
    child.once("close", (code) => {
      if (code !== 0) return abort();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

function text(bytes) {
  try { return decoder.decode(bytes); } catch { fail("Invalid source metadata encoding"); }
}

async function absent(filename) {
  try { await lstat(filename); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail("Source destination must not exist");
}

async function ownedDirectory(filename) {
  const info = await lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(filename) !== filename) fail("Unsafe source staging directory");
  return { path: filename, dev: info.dev, ino: info.ino };
}

async function removeOwned(identity, parent, prefix) {
  if (!identity || path.dirname(identity.path) !== parent || !path.basename(identity.path).startsWith(prefix)) fail("Unsafe source cleanup target");
  const info = await lstat(identity.path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) fail("Source staging directory changed");
  await rm(identity.path, { recursive: true });
}

function inventory(bytes, expected, initial, baseline, approved) {
  const records = text(bytes).trimEnd().split("\n");
  if (records.length > MAX_OBJECTS) fail("Source object count limit exceeded");
  const objects = new Map();
  let metadataSize = 0;
  let blobSize = 0;
  for (const record of records) {
    const match = /^([0-9a-f]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(record);
    if (!match) fail(`${initial ? "Initial" : "Final"} inventory contains an unexpected object`);
    const [, oid, type, rawSize] = match;
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || objects.has(oid)) fail("Invalid source object size or duplicate inventory");
    if (type === "blob") {
      if (initial || !approved.has(oid)) fail(`${initial ? "Initial" : "Final"} inventory contains an unapproved blob`);
      if (size > MAX_FILE_BYTES) fail("Source file size limit exceeded");
      blobSize += size;
    } else {
      if (type === "commit" && oid !== expected) fail(`${initial ? "Initial" : "Final"} inventory contains another commit`);
      if (!initial && (!baseline.has(oid) || baseline.get(oid).type !== type || baseline.get(oid).size !== size)) fail("Final inventory contains unexpected metadata");
      metadataSize += size;
    }
    objects.set(oid, { type, size });
  }
  if (objects.get(expected)?.type !== "commit" || ![...objects.values()].some(({ type }) => type === "tree")) fail(`${initial ? "Initial" : "Final"} inventory is missing source metadata`);
  if (metadataSize > MAX_METADATA_BYTES || blobSize > MAX_TOTAL_BYTES) fail("Source total size limit exceeded");
  if (!initial && (objects.size !== baseline.size + approved.size || [...approved].some((oid) => objects.get(oid)?.type !== "blob") || [...baseline.keys()].some((oid) => !objects.has(oid)))) fail("Final inventory does not match the exact approved object set");
  return objects;
}

function treeEntries(bytes) {
  const listing = text(bytes);
  if (!listing.endsWith("\0")) fail("Invalid source tree listing");
  const records = listing.slice(0, -1).split("\0");
  if (records.length > MAX_FILES) fail("Source file count limit exceeded");
  const seen = new Map();
  const paths = new Set();
  const entries = records.map((record) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
    if (!match) fail("Source tree contains an unsupported mode or type");
    const [, mode, oid, name] = match;
    const parts = name.split("/");
    if (!/^(frontend|mobile)\//.test(name) || name.length > 1024 || parts.length > 32) fail("Invalid source tree path");
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!/^[A-Za-z0-9_.@+(),\[\] -]+$/.test(part) || /^ |[ .]$/.test(part) || part === "." || part === ".." || part.toLowerCase() === ".git" || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail("Unsafe source tree path");
      const prefix = parts.slice(0, index + 1).join("/");
      const folded = prefix.toLowerCase();
      if (seen.has(folded) && seen.get(folded) !== prefix) fail("Source tree path has a case collision");
      seen.set(folded, prefix);
    }
    if (paths.has(name)) fail("Duplicate source tree path");
    paths.add(name);
    return { mode, oid, name };
  });
  for (const entry of entries) {
    const parts = entry.name.split("/");
    for (let index = 1; index < parts.length; index++) if (paths.has(parts.slice(0, index).join("/"))) fail("Source tree path is both a file and directory");
  }
  if (!["frontend/", "mobile/"].every((prefix) => entries.some(({ name }) => name.startsWith(prefix)))) fail("Source tree must contain frontend and mobile files");
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Test-only dependency injection replaces transport, never the CLI remote or security policy.
export async function exportSource(destination, { env = process.env, run = stockGit } = {}) {
  let stage;
  let output;
  let parent;
  let basename;
  try {
    const expected = env.EXPECTED_SOURCE_SHA;
    if (typeof expected !== "string" || !/^[0-9a-fA-F]{40}$/.test(expected)) fail("Expected source SHA must be exactly 40 hexadecimal characters");
    const sha = expected.toLowerCase();
    if (![env.GITLAB_READ_USERNAME, env.GITLAB_READ_TOKEN].every((value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value))) fail("Source credentials are missing or invalid");
    if (typeof destination !== "string" || !destination || destination.includes("\0")) fail("Invalid source destination");
    const resolved = path.resolve(destination);
    basename = path.basename(resolved);
    if (resolved === path.parse(resolved).root || basename.toLowerCase() === ".git") fail("Invalid source destination");
    parent = await realpath(path.dirname(resolved));
    const dest = path.join(parent, basename);
    await absent(dest);
    const started = Date.now();
    const stagePath = await mkdtemp(path.join(parent, ".android-source-"));
    stage = await ownedDirectory(stagePath);
    const home = path.join(stagePath, "home");
    const repo = path.join(stagePath, "git");
    const exported = path.join(stagePath, "export");
    const askpass = path.join(home, "askpass.sh");
    await mkdir(home, { mode: 0o700 });
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  Username*) printf "%s\\n" "$GITLAB_READ_USERNAME" ;;\n  Password*) printf "%s\\n" "$GITLAB_READ_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700, flag: "wx" });
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      TMPDIR: home,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PROTOCOL_FROM_USER: "0",
    };
    const config = [
      "protocol.version=2", "protocol.allow=never", "protocol.https.allow=always",
      "credential.helper=", "credential.useHttpPath=true",
      "http.followRedirects=false", "http.sslVerify=true", "http.proxy=", "http.saveCookies=false",
      "http.lowSpeedLimit=1024", "http.lowSpeedTime=20", "http.maxRequests=1",
      "core.hooksPath=/dev/null", "core.attributesFile=/dev/null", "core.fsmonitor=false",
      "fetch.recurseSubmodules=false", "submodule.recurse=false", "fetch.writeCommitGraph=false",
      "gc.auto=0", "maintenance.auto=false", "transfer.bundleURI=false", "promisor.acceptFromServer=none",
    ].flatMap((value) => ["-c", value]);
    const command = async (args, { network = false, cwd = repo, input } = {}) => {
      const remaining = TOTAL_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0) fail("Source operation time limit exceeded");
      const offline = network ? [] : ["-c", "protocol.https.allow=never", "-c", "remote.origin.promisor=false"];
      const childEnv = network ? { ...cleanEnv, GIT_ASKPASS: askpass, GITLAB_READ_USERNAME: env.GITLAB_READ_USERNAME, GITLAB_READ_TOKEN: env.GITLAB_READ_TOKEN } : cleanEnv;
      let bytes;
      try {
        bytes = await run([...config, ...offline, ...args], { cwd, env: childEnv, input, timeout: Math.min(COMMAND_TIMEOUT_MS, remaining), killSignal: "SIGKILL", maxBuffer: MAX_COMMAND_BYTES, stdio: ["pipe", "pipe", "pipe"] });
      } catch { fail("Source Git command failed or exceeded its limit"); }
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_COMMAND_BYTES) fail("Invalid or oversized source command output");
      return bytes;
    };
    const advertised = text(await command(["ls-remote", "--refs", REMOTE, "refs/heads/main"], { network: true, cwd: stagePath }));
    if (advertised !== `${sha}\trefs/heads/main\n`) fail("Expected source SHA does not match the actual main tip");
    await command(["clone", "--no-checkout", "--filter=blob:none", "--depth=1", "--single-branch", "--branch=main", "--no-tags", "--no-local", "--no-hardlinks", "--template=", "--quiet", "--", REMOTE, repo], { network: true, cwd: stagePath });
    const initial = inventory(await command(["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]), sha, true);
    if (text(await command(["rev-parse", "--verify", "refs/heads/main"])) !== `${sha}\n`) fail("Cloned main tip does not match expected source SHA");
    const entries = treeEntries(await command(["ls-tree", "-r", "-z", "--full-tree", sha, "--", "frontend/", "mobile/"]));
    const approved = new Set(entries.map(({ oid }) => oid));
    await command(["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--stdin", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "--no-progress", "--refmap=", "--filter=blob:none", "origin"], { network: true, input: Buffer.from([...approved].sort().join("\n") + "\n") });
    const final = inventory(await command(["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]), sha, false, initial, approved);
    let exportedBytes = 0;
    const digest = createHash("sha256");
    await mkdir(exported, { mode: 0o700 });
    for (const { mode, oid, name } of entries) {
      const size = final.get(oid).size;
      exportedBytes += size;
      if (exportedBytes > MAX_TOTAL_BYTES) fail("Source total file size limit exceeded");
      const bytes = await command(["cat-file", "blob", oid]);
      if (bytes.length !== size || createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex") !== oid) fail("Source blob integrity check failed");
      if (bytes.subarray(0, 1024).includes(Buffer.from("version https://git-lfs.github.com/spec/v1"))) fail("Git LFS pointers are not supported");
      const filename = path.resolve(exported, name);
      if (!filename.startsWith(exported + path.sep)) fail("Unsafe source output path");
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, bytes, { flag: "wx", mode: mode === "100755" ? 0o755 : 0o644 });
      digest.update(`${mode} ${oid} ${size}\t${name}\n`);
    }
    const result = { sourceCommit: sha, filecount: entries.length, sourceTreeSha256: digest.digest("hex") };
    // Destroy metadata and the credential-free askpass before making any source available to builds.
    await removeOwned(await ownedDirectory(repo), stagePath, "git");
    await removeOwned(await ownedDirectory(home), stagePath, "home");
    await mkdir(dest, { mode: 0o700 });
    output = await ownedDirectory(dest);
    for (const name of ["frontend", "mobile"]) await rename(path.join(exported, name), path.join(dest, name));
    await removeOwned(stage, parent, ".android-source-");
    stage = undefined;
    output = undefined;
    return result;
  } catch (error) {
    try {
      if (output) await removeOwned(output, parent, basename);
      if (stage) await removeOwned(stage, parent, ".android-source-");
    } catch { fail("Source cleanup failed; do not build or publish this run"); }
    if (error instanceof SourceError) throw error;
    fail("Source preparation failed; no source was exported");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) fail("Usage: node scripts/android-source.mjs <destination>");
    process.stdout.write(JSON.stringify(await exportSource(process.argv[2])) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof SourceError ? error.message : "Source preparation failed") + "\n");
    process.exitCode = 1;
  }
}
