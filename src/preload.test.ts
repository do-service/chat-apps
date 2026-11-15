import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import * as contract from "./contract";
import * as security from "./security";
import * as updateContract from "./update-contract";
import * as updateIPC from "./update-ipc";

const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/preload.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);

function fixture(mainFrame = true, origin = "https://chat.example", response: unknown = undefined) {
  const calls: { channel: string; value: unknown }[] = [];
  const exposed: Record<string, unknown> = {};
  const window = { location: { origin, href: `${origin}/` }, top: {} };
  window.top = window;
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, bridge: unknown) => { exposed[name] = bridge; } },
    ipcRenderer: { invoke: async (channel: string, value: unknown) => { calls.push({ channel, value }); return response; } },
  };
  runInNewContext(compiled.stdout, {
    require: (name: string) => {
      if (name === "electron") return electron;
      if (name === "./contract") return contract;
      if (name === "./security") return security;
      if (name === "./update-contract") return updateContract;
      if (name === "./update-ipc") return updateIPC;
      throw new Error(`Unexpected module ${name}`);
    },
    process: { isMainFrame: mainFrame, argv: [`${security.TRUSTED_ORIGIN_ARGUMENT}https://chat.example`] }, window,
  });
  return { calls, bridge: exposed.chatDesktop, updates: exposed.chatUpdates };
}

test("preload exposes additive dismiss operation with strict validation before IPC", async () => {
  const f = fixture();
  assert.ok(contract.isRecord(f.bridge));
  const dismiss = f.bridge.dismissNotifications;
  assert.equal(typeof dismiss, "function");
  assert.ok(typeof dismiss === "function");
  const message = { accountId: "alice", kind: "message", chatId: "chat_1", throughMessageId: 5 };
  for (const selector of [message, { accountId: "alice", kind: "call", callId: "call_1" },
    { accountId: "alice", kind: "call", exceptCallIds: ["call_1"] }]) {
    await dismiss(selector);
    assert.deepEqual(f.calls.at(-1), { channel: contract.IPC.dismissNotifications, value: selector });
  }
  const accepted = f.calls.length;
  for (const selector of [null, { ...message, extra: true }, { ...message, throughMessageId: -1 },
    { accountId: "alice", kind: "call", exceptCallIds: ["bad/id"] }]) {
    await assert.rejects(async () => dismiss(selector));
  }
  assert.equal(f.calls.length, accepted);
});

test("preload exposes permission methods and validates every permission result", async () => {
  for (const result of ["not-determined", "granted", "denied", "unknown", "restricted", true, null, {}]) {
    const f = fixture(true, "https://chat.example", result);
    assert.ok(contract.isRecord(f.bridge));
    for (const name of ["getNotificationPermission", "requestNotificationPermission"]) {
      const method: unknown = f.bridge[name]; assert.ok(typeof method === "function", name);
      if (typeof result === "string" && ["not-determined", "granted", "denied", "unknown"].includes(result)) {
        assert.equal(await method(), result);
      } else await assert.rejects(async () => method(), /Invalid notification permission/);
    }
    assert.equal(typeof f.bridge.openNotificationSettings, "function");
  }
});

test("independent immutable updates bridge validates exact noargs and every snapshot without extending legacy bridge", async () => {
  const state: updateContract.UpdateState = { version: 1, platform: "darwin", currentVersion: "0.1.0", currentBuild: null, channel: "preview", mode: "external", status: "idle", availableVersion: null, progress: null, error: null };
  const f = fixture(true, "https://chat.example", state);
  assert.ok(contract.isRecord(f.updates)); assert.equal(Object.isFrozen(f.updates), true);
  assert.ok(contract.isRecord(f.bridge)); assert.equal("check" in f.bridge, false);
  for (const [name, channel] of Object.entries(updateIPC.UPDATE_IPC)) {
    const method: unknown = f.updates[name]; assert.ok(typeof method === "function");
    assert.deepEqual(await method(), state); assert.deepEqual(f.calls.at(-1), { channel, value: undefined });
    const before = f.calls.length;
    for (const arg of [undefined, null, "https://evil.example/a.exe", {}]) await assert.rejects(async () => method(arg), /Invalid update arguments/);
    assert.equal(f.calls.length, before);
    const bad = fixture(true, "https://chat.example", { ...state, url: "https://evil.example" });
    assert.ok(contract.isRecord(bad.updates)); const invalid: unknown = bad.updates[name]; assert.ok(typeof invalid === "function");
    await assert.rejects(async () => invalid(), /Invalid update state/);
  }
  assert.equal(fixture(false).updates, undefined);
  assert.equal(fixture(true, "https://attacker.example").updates, undefined);
});

test("preload does not expose dismiss or any bridge to foreign pages/subframes", () => {
  assert.equal(fixture(false).bridge, undefined);
  assert.equal(fixture(true, "https://attacker.example").bridge, undefined);
});
