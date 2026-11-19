import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";

const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/server-selection-preload.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);

function fixture(options: { mainFrame?: boolean; url?: string; args?: string[]; missingControl?: boolean; proxy?: "inline" | "only" } = {}) {
  const calls: unknown[][] = [];
  const token = "a".repeat(64); const documentId = "b".repeat(64);
  const ipc = new EventEmitter(); const events = new EventEmitter(); const docEvents = new EventEmitter();
  let active: unknown = null;
  class Element extends EventEmitter {
    textContent = "";
    hidden = false;
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
  class Select extends Input {}
  const proxy = { panel: new Element(), serverPanel: new Element(), gear: new Button(), mode: new Select(), scope: new Select(),
    fields: new Element(), host: new Input(), port: new Input(), error: new Element(), save: new Button(), cancel: new Button() };
  if (options.proxy) {
    proxy.mode.value = "default"; proxy.scope.value = "check"; proxy.host.value = ""; proxy.port.value = "";
    proxy.panel.hidden = options.proxy === "inline";
    Object.assign(controls, { "proxy-panel": proxy.panel, "proxy-mode": proxy.mode, "proxy-scope": proxy.scope,
      "proxy-fields": proxy.fields, "proxy-host": proxy.host, "proxy-port": proxy.port, "proxy-error": proxy.error,
      "proxy-save": proxy.save, "proxy-cancel": proxy.cancel });
    if (options.proxy === "inline") Object.assign(controls, { "server-panel": proxy.serverPanel, "server-proxy": proxy.gear });
    else for (const id of ["server-cancel", "server-confirm", "server-url", "server-error"]) delete controls[id];
  }
  const document = { readyState: "loading", get activeElement() { return active; },
    getElementById: (id: string) => options.missingControl && id === "server-confirm" ? null : controls[id],
    addEventListener: (name: string, handler: () => void) => docEvents.on(name, handler),
    removeEventListener: (name: string, handler: () => void) => docEvents.off(name, handler),
  };
  const window = { top: {}, location: new URL(options.url ?? `chat-server-selection://dialog/${documentId}`),
    addEventListener: (name: string, handler: () => void) => events.on(name, handler),
    removeEventListener: (name: string, handler: () => void) => events.off(name, handler) };
  window.top = window;
  runInNewContext(compiled.stdout, { window, document, HTMLButtonElement: Button, HTMLInputElement: Input, HTMLSelectElement: Select, HTMLElement: Element,
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
  return { calls, token, cancel, confirm, input, error, ipc, key, proxy, get active() { return active; },
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

test("inline gear and Escape switch the local panel without erasing the server input", () => {
  const f = fixture({ proxy: "inline" });
  f.input.value = "https://typed.example/";
  f.click(f.proxy.gear, false); assert.equal(f.proxy.panel.hidden, true);
  f.key("Tab"); assert.equal(f.active, f.proxy.gear); f.key("Enter");
  assert.equal(f.active, f.proxy.mode); assert.equal(f.proxy.serverPanel.hidden, true);
  assert.equal(f.proxy.gear.attributes.get("aria-expanded"), "true");
  f.key("Escape"); assert.equal(f.proxy.panel.hidden, true); assert.equal(f.active, f.proxy.gear);
  assert.equal(f.input.value, "https://typed.example/"); assert.deepEqual(f.calls, []);
});

test("proxy mode controls manual fields, sends no stale details and renders only a generic error", () => {
  const f = fixture({ proxy: "inline" }); f.click(f.proxy.gear);
  assert.equal(f.proxy.fields.hidden, true);
  f.proxy.mode.value = "socks5"; f.proxy.mode.emit("change", { isTrusted: true });
  assert.equal(f.proxy.fields.hidden, false); assert.equal(f.proxy.host.disabled, false);
  f.proxy.host.value = "proxy.example"; f.proxy.port.value = "0"; f.click(f.proxy.save);
  assert.deepEqual(f.calls, []); assert.equal(f.active, f.proxy.port);
  f.proxy.port.value = "1080"; f.proxy.scope.value = "all"; f.key("Enter"); f.click(f.proxy.save);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ["chat:server-selection-proxy", f.token,
    { mode: "socks5", scope: "all", host: "proxy.example", port: 1080 }]);
  f.ipc.emit("chat:server-selection-proxy-result", {}, "wrong", false);
  f.ipc.emit("chat:server-selection-proxy-result", {}, f.token, "private details");
  assert.equal(f.proxy.error.textContent, "");
  f.ipc.emit("chat:server-selection-proxy-result", {}, f.token, false);
  assert.match(f.proxy.error.textContent, /Не удалось сохранить/); assert.equal(f.proxy.save.disabled, false);
  f.proxy.mode.value = "system"; f.proxy.mode.emit("change", { isTrusted: true });
  f.click(f.proxy.save);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), ["chat:server-selection-proxy", f.token, { mode: "system", scope: "all" }]);
  f.ipc.emit("chat:server-selection-proxy-result", {}, f.token, true);
  assert.equal(f.proxy.panel.hidden, true); assert.equal(f.active, f.proxy.gear);
  assert.equal(f.calls.length, 2);
});

test("standalone proxy starts at its own controls and Cancel cannot select a server", () => {
  const f = fixture({ proxy: "only" }); assert.equal(f.active, f.proxy.mode);
  f.key("Escape"); assert.deepEqual(f.calls, [["chat:server-selection-proxy", f.token, null]]);
  assert.equal(f.ipc.listenerCount("chat:server-selection-proxy-result"), 0);
});
