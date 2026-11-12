import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";

const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/external-link-preload.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);

function fixture(options: { mainFrame?: boolean; url?: string; args?: string[]; missingButton?: boolean } = {}) {
  const calls: unknown[][] = [];
  const token = "a".repeat(64);
  const documentId = "b".repeat(64);
  const events = new EventEmitter();
  const docEvents = new EventEmitter();
  let active: unknown = null;
  class Element extends EventEmitter {
    addEventListener(name: string, handler: () => void) { this.on(name, handler); }
    removeEventListener(name: string, handler: () => void) { this.off(name, handler); }
    focus() { active = this; }
  }
  class Button extends Element { disabled = false; }
  const close = new Button(); const cancel = new Button(); const open = new Button(); const destination = new Element();
  const buttons: Record<string, Element> = { "external-close": close, "external-cancel": cancel, "external-open": open,
    "external-destination": destination };
  const document = { readyState: "loading", get activeElement() { return active; },
    getElementById: (id: string) => options.missingButton && id === "external-open" ? null : buttons[id],
    addEventListener: (name: string, handler: () => void) => docEvents.on(name, handler),
    removeEventListener: (name: string, handler: () => void) => docEvents.off(name, handler),
  };
  const window = { top: {}, location: new URL(options.url ?? `chat-external-link://dialog/${documentId}`),
    addEventListener: (name: string, handler: () => void) => events.on(name, handler),
    removeEventListener: (name: string, handler: () => void) => events.off(name, handler) };
  window.top = window;
  runInNewContext(compiled.stdout, { window, document, HTMLButtonElement: Button, HTMLElement: Element,
    process: { isMainFrame: options.mainFrame ?? true,
      argv: options.args ?? [`--chat-external-link-token=${token}`, `--chat-external-link-document=${documentId}`] },
    require: (name: string) => {
      assert.equal(name, "electron"); return { ipcRenderer: { send: (...args: unknown[]) => calls.push(args) } };
    },
  });
  docEvents.emit("DOMContentLoaded");
  const key = (value: string, shiftKey = false) => {
    let prevented = false;
    docEvents.emit("keydown", { key: value, shiftKey, isTrusted: true, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { calls, token, close, cancel, open, destination, key, get active() { return active; },
    click: (button: Button, trusted = true) => button.emit("click", { isTrusted: trusted }),
    blurFocus: () => { active = null; }, unload: () => events.emit("pagehide") };
}

test("sandbox preload exposes no bridge, focuses cancel and sends only private token and boolean once", () => {
  const f = fixture(); assert.equal(f.active, f.cancel);
  f.click(f.open, false); assert.deepEqual(f.calls, []);
  f.click(f.open); f.click(f.cancel);
  assert.deepEqual(f.calls, [["chat:external-link-choice", f.token, true]]);
});

test("cancel and X buttons return false", () => {
  for (const button of ["cancel", "close"]) {
    const f = fixture(); f.click(button === "cancel" ? f.cancel : f.close);
    assert.deepEqual(f.calls, [["chat:external-link-choice", f.token, false]]);
  }
});

test("Tab/Shift+Tab are trapped and Enter activates only a focused button", () => {
  const f = fixture(); assert.equal(f.key("Tab"), true); assert.equal(f.active, f.open);
  f.key("Tab"); assert.equal(f.active, f.close);
  f.key("Tab", true); assert.equal(f.active, f.open);
  f.blurFocus(); assert.equal(f.key("Enter"), true); assert.deepEqual(f.calls, []);
  f.key("Tab"); assert.equal(f.active, f.cancel); f.key("Enter");
  assert.deepEqual(f.calls, [["chat:external-link-choice", f.token, false]]);
  const open = fixture(); open.key("Tab"); open.key("Enter");
  assert.deepEqual(open.calls, [["chat:external-link-choice", open.token, true]]);
});

test("long URL region joins the focus trap and permits native scrolling but cannot confirm with Enter", () => {
  const f = fixture(); f.key("Tab", true); assert.equal(f.active, f.destination);
  assert.equal(f.key("Enter"), true); assert.deepEqual(f.calls, []);
  assert.equal(f.key("PageDown"), false); assert.equal(f.key("End"), false);
  f.key("Tab", true); assert.equal(f.active, f.close);
  f.key("Tab"); assert.equal(f.active, f.destination);
  f.key("Tab"); assert.equal(f.active, f.cancel);
  f.key("Tab"); assert.equal(f.active, f.open);
  f.key("Enter"); assert.deepEqual(f.calls, [["chat:external-link-choice", f.token, true]]);
});

test("Escape cancels and pagehide removes active DOM handlers", () => {
  const escape = fixture(); escape.key("Escape");
  assert.deepEqual(escape.calls, [["chat:external-link-choice", escape.token, false]]);
  const f = fixture(); f.unload(); f.click(f.open); f.key("Enter"); assert.deepEqual(f.calls, []);
});

test("subframes, foreign documents, absent/duplicate tokens and missing controls cannot send", () => {
  for (const options of [{ mainFrame: false }, { url: "https://attacker.example/" },
    { url: `data:text/html;charset=utf-8,foreign#${"b".repeat(64)}` },
    { url: `chat-external-link://dialog/${"b".repeat(64)}/foreign` },
    { url: `chat-external-link://foreign/${"b".repeat(64)}` }, { args: [] },
    { args: ["--chat-external-link-token=bad", `--chat-external-link-document=${"b".repeat(64)}`] },
    { args: [`--chat-external-link-token=${"a".repeat(64)}`, `--chat-external-link-token=${"a".repeat(64)}`, `--chat-external-link-document=${"b".repeat(64)}`] },
    { missingButton: true }]) {
    const f = fixture(options); f.click(f.open); f.key("Enter"); assert.deepEqual(f.calls, []);
  }
});
