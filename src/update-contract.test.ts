import assert from "node:assert/strict";
import test from "node:test";
import { isNativeUpdatesBridge, isUpdateState, type UpdateState } from "./update-contract";

const state: UpdateState = {
  version: 1, platform: "android", currentVersion: "0.1.0-preview.1", currentBuild: "1",
  channel: "preview", mode: "install", status: "available", availableVersion: "0.1.0-preview.2",
  progress: null, error: null,
};
test("native update snapshot validates platform-specific native versions without a web build ID", () => {
  assert.equal(isUpdateState(state), true);
  for (const platform of ["darwin", "win32", "linux", "android", "ios"]) {
    assert.equal(isUpdateState({ ...state, platform, currentVersion: "1.0", currentBuild: null }), true);
  }
  assert.equal(isUpdateState({ ...state, mode: "unconfigured", status: "unavailable", availableVersion: null, error: "unconfigured" }), true);
});
test("native update snapshot rejects untrusted structure and unbounded values", () => {
  const invalid: unknown[] = [null, [], {}, { ...state, url: "https://evil.example" },
    { ...state, platform: "browser" }, { ...state, version: 2 }, { ...state, channel: "stable" },
    { ...state, mode: "silent" }, { ...state, status: "installed" }, { ...state, error: "raw secret" },
    { ...state, currentVersion: "" }, { ...state, currentVersion: "x".repeat(65) },
    { ...state, currentVersion: "1.0\nsecret" }, { ...state, currentBuild: "-1" },
    { ...state, currentBuild: 1 }, { ...state, availableVersion: "https://evil.example" },
    { ...state, progress: Number.NaN }, { ...state, progress: Infinity },
    { ...state, progress: -1 }, { ...state, progress: 101 }, { ...state, progress: "50" }];
  for (const value of invalid) assert.equal(isUpdateState(value), false);
  const { error: _error, ...missing } = state;
  assert.equal(isUpdateState(missing), false);
});
test("optional update bridge has only no-argument operations and never weakens the old bridge", () => {
  const operation = async () => state;
  const bridge = { version: 1, getState: operation, check: operation, download: operation, install: operation, openRelease: operation };
  assert.equal(isNativeUpdatesBridge(bridge), true);
  for (const key of ["getState", "check", "download", "install", "openRelease"]) {
    assert.equal(isNativeUpdatesBridge({ ...bridge, [key]: undefined }), false);
  }
  assert.equal(isNativeUpdatesBridge({ ...bridge, version: 2 }), false);
  assert.equal(isNativeUpdatesBridge(undefined), false);
});
