import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function buildNotificationPermission() {
  if (process.platform !== "darwin") return;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const include = [
    process.env.NODE_API_INCLUDE,
    resolve(dirname(process.execPath), "..", "include", "node"),
    join(homedir(), "Library", "Caches", "node-gyp", process.versions.node, "include", "node"),
    "/opt/homebrew/include/node", "/usr/local/include/node",
  ].find((path) => path && existsSync(join(path, "node_api.h")));
  if (!include) throw new Error("Node-API headers unavailable; set NODE_API_INCLUDE to an installed Node include directory");
  const sdk = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" });
  if (sdk.status !== 0 || !sdk.stdout.trim()) throw new Error("macOS SDK unavailable");
  await mkdir(join(root, "dist"), { recursive: true });
  // A universal tiny addon supports both targets of package:mac without a host-arch mismatch.
  const result = spawnSync("/usr/bin/clang++", [
    "-std=c++17", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
    "-DNAPI_VERSION=8", "-DNODE_GYP_MODULE_NAME=notification_permission",
    "-mmacosx-version-min=13.0", "-arch", "arm64", "-arch", "x86_64",
    "-isysroot", sdk.stdout.trim(), "-isystem", join(sdk.stdout.trim(), "usr", "include", "c++", "v1"), "-I", include,
    "-bundle", "-undefined", "dynamic_lookup", "-framework", "Foundation", "-framework", "UserNotifications",
    join(root, "native", "notification-permission.mm"), "-o", join(root, "dist", "notification-permission.node"),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Native notification permission compilation failed");
}
