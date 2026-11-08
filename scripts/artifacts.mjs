import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const targets = new Map([
  ["windows", ["win-x64.exe"]],
  ["macos", ["mac-arm64.dmg", "mac-x64.dmg"]],
  ["linux", ["linux-x64.AppImage"]],
]);

export async function prepareArtifacts(root, platform) {
  const suffixes = targets.get(platform);
  if (!suffixes) throw new Error("Unknown artifact platform");
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid package version for artifact filenames");
  }
  const release = path.join(root, "release");
  if (!(await lstat(release)).isDirectory()) throw new Error("release must be a regular directory");
  const names = suffixes.map((suffix) => `chat-desktop-spike-${version}-${suffix}`);
  const checksums = [];
  for (const name of names) {
    const filename = path.join(release, name);
    const info = await lstat(filename);
    if (!info.isFile() || info.size === 0) throw new Error(`Expected a non-empty regular file: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    checksums.push(`${hash.digest("hex")}  ${name}\n`);
  }
  // Fail closed on stale output or symlinks rather than overwriting an existing manifest.
  await writeFile(path.join(release, "SHA256SUMS.txt"), checksums.join(""), { flag: "wx" });
  return names.map((name) => `release/${name}`).concat("release/SHA256SUMS.txt");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/artifacts.mjs <windows|macos|linux>");
    const paths = (await prepareArtifacts(process.cwd(), process.argv[2])).join("\n") + "\n";
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `paths<<DESKTOP_ARTIFACT_PATHS\n${paths}DESKTOP_ARTIFACT_PATHS\n`);
    }
    process.stdout.write(paths);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
