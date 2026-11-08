import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import * as contract from "./contract";
import * as security from "./security";

const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/preload.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);

function fixture(mainFrame = true, origin = "https://chat.example") {
  const calls: { channel: string; value: unknown }[] = [];
  let exposed: unknown;
  const window = { location: { origin, href: `${origin}/` }, top: {} };
  window.top = window;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name: string, bridge: unknown) => { exposed = bridge; } },
    ipcRenderer: { invoke: async (channel: string, value: unknown) => { calls.push({ channel, value }); } },
  };
  runInNewContext(compiled.stdout, {
    require: (name: string) => {
      if (name === "electron") return electron;
      if (name === "./contract") return contract;
      if (name === "./security") return security;
      throw new Error(`Unexpected module ${name}`);
    },
    process: { isMainFrame: mainFrame, argv: [`${security.TRUSTED_ORIGIN_ARGUMENT}https://chat.example`] }, window,
  });
  assert.ok(exposed === undefined || contract.isRecord(exposed));
  return { calls, bridge: exposed };
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

test("preload does not expose dismiss or any bridge to foreign pages/subframes", () => {
  assert.equal(fixture(false).bridge, undefined);
  assert.equal(fixture(true, "https://attacker.example").bridge, undefined);
});
