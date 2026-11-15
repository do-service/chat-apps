import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";

const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/server-selection-preload.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);

function fixture(options: { mainFrame?: boolean; url?: string; args?: string[]; missingControl?: boolean } = {}) {
  const calls: unknown[][] = [];
  const token = "a".repeat(64); const documentId = "b".repeat(64);
  const ipc = new EventEmitter(); const events = new EventEmitter(); const docEvents = new EventEmitter();
  let active: unknown = null;
  class Element extends EventEmitter {
    textContent = "";
    attributes = new Map<string, string>();
    addEventListener(name: string, handler: () => void) { this.on(name, handler); }
    removeEventListener(name: string, handler: () => void) { this.off(name, handler); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    focus() { active = this; }
  }
  class Button extends Element { disabled = false; }
  class Input extends Element { value = "https://example.com/"; disabled = false; }
  const cancel = new Button(); const confirm = new Button(); const input = new Input(); const error = new Element();
  const controls: Record<string, Element> = { "server-cancel": cancel, "server-confirm": confirm, "server-url": input, "server-error": error };
  const document = { readyState: "loading", get activeElement() { return active; },
    getElementById: (id: string) => options.missingControl && id === "server-confirm" ? null : controls[id],
    addEventListener: (name: string, handler: () => void) => docEvents.on(name, handler),
    removeEventListener: (name: string, handler: () => void) => docEvents.off(name, handler),
  };
  const window = { top: {}, location: new URL(options.url ?? `chat-server-selection://dialog/${documentId}`),
    addEventListener: (name: string, handler: () => void) => events.on(name, handler),
    removeEventListener: (name: string, handler: () => void) => events.off(name, handler) };
  window.top = window;
  runInNewContext(compiled.stdout, { window, document, HTMLButtonElement: Button, HTMLInputElement: Input, HTMLElement: Element,
    process: { isMainFrame: options.mainFrame ?? true,
      argv: options.args ?? [`--chat-server-selection-token=${token}`, `--chat-server-selection-document=${documentId}`] },
    require: (name: string) => {
      assert.equal(name, "electron"); return { ipcRenderer: Object.assign(ipc, { send: (...args: unknown[]) => calls.push(args) }) };
    },
  });
  docEvents.emit("DOMContentLoaded");
  const key = (key: string, shiftKey = false, isTrusted = true) => {
    let prevented = false;
    docEvents.emit("keydown", { key, shiftKey, isTrusted, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { calls, token, cancel, confirm, input, error, ipc, key, get active() { return active; },
    click: (button: Button, trusted = true) => button.emit("click", { isTrusted: trusted }),
    unload: () => events.emit("pagehide") };
}

test("private preload submits only trusted input, disables duplicate submits, and exposes no bridge", () => {
  const f = fixture(); assert.equal(f.active, f.input);
  f.click(f.confirm, false); f.key("Enter", false, false); assert.deepEqual(f.calls, []);
  f.click(f.confirm); f.click(f.confirm);
  assert.deepEqual(f.calls, [["chat:server-selection-choice", f.token, "https://example.com/"]]);
  assert.equal(f.confirm.disabled, true);
});

test("fixed error for matching token re-enables input and retry, foreign IPC cannot change UI", () => {
  const f = fixture(); f.click(f.confirm);
  f.ipc.emit("chat:server-selection-error", {}, "wrong", "foreign"); assert.equal(f.error.textContent, "");
  f.ipc.emit("chat:server-selection-error", {}, f.token, "bad address");
  assert.equal(f.error.textContent, "bad address"); assert.equal(f.confirm.disabled, false);
  assert.equal(f.active, f.input); assert.equal(f.input.attributes.get("aria-invalid"), "true");
  f.input.value = "https://second.example/"; f.key("Enter");
  assert.deepEqual(f.calls.at(-1), ["chat:server-selection-choice", f.token, "https://second.example/"]);
});

test("Escape and Cancel return null even during a pending validation", () => {
  for (const mode of ["escape", "cancel"]) {
    const f = fixture(); f.click(f.confirm);
    if (mode === "escape") f.key("Escape"); else f.click(f.cancel);
    assert.deepEqual(f.calls.at(-1), ["chat:server-selection-choice", f.token, null]);
    assert.equal(f.ipc.listenerCount("chat:server-selection-error"), 0);
  }
});

test("keyboard focus trap and focused Cancel Enter work without form navigation", () => {
  const f = fixture(); assert.equal(f.key("Tab"), true); assert.equal(f.active, f.cancel);
  f.key("Tab", true); assert.equal(f.active, f.input);
  f.key("Tab", true); assert.equal(f.active, f.confirm);
  f.key("Tab"); assert.equal(f.active, f.input);
  f.key("Tab"); f.key("Enter"); assert.deepEqual(f.calls, [["chat:server-selection-choice", f.token, null]]);
});

test("pagehide removes DOM/IPC listeners, subframes/foreign documents/bad tokens fail closed", () => {
  const hidden = fixture(); hidden.unload(); hidden.click(hidden.confirm); hidden.key("Enter");
  assert.deepEqual(hidden.calls, []); assert.equal(hidden.ipc.listenerCount("chat:server-selection-error"), 0);
  for (const options of [{ mainFrame: false }, { url: "https://attacker.example/" },
    { url: `chat-server-selection://dialog/${"b".repeat(64)}#foreign` }, { args: [] },
    { args: [`--chat-server-selection-token=${"a".repeat(64)}`, `--chat-server-selection-token=${"a".repeat(64)}`, `--chat-server-selection-document=${"b".repeat(64)}`] },
    { missingControl: true }]) {
    const f = fixture(options); f.click(f.confirm); f.key("Enter"); assert.deepEqual(f.calls, []);
  }
});
