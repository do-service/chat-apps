import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("build rejects non-origin URLs before embedding config and does not print sensitive input", () => {
  for (const value of ["", "http://chat.example", "https://chat.example/path", "https://chat.example/a/..",
    "https://chat.example?", "https://chat.example/#", "https://chat.example\\bad", "https://chat.example\n",
    "https://user:do-not-log-me@chat.example", "https://user:do-not-log-me@%"] ) {
    const result = spawnSync(process.execPath, [resolve("scripts/build.mjs")], {
      encoding: "utf8", env: { ...process.env, DESKTOP_APP_URL: value },
    });
    assert.notEqual(result.status, 0);
    assert.equal((result.stdout + result.stderr).includes("do-not-log-me"), false);
    assert.match(result.stderr, /DESKTOP_APP_URL/);
  }
});
