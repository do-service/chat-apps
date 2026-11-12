import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as document from "./external-link-document";

const compiled = spawnSync(process.execPath, ["--input-type=module", "-e",
  'import { transformSync } from "esbuild"; import { readFileSync } from "node:fs"; process.stdout.write(transformSync(readFileSync("src/external-link-dialog.ts", "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code);',
], { encoding: "utf8" });
assert.equal(compiled.status, 0, compiled.stderr);

function fixture(failure?: "constructor" | "session" | "load-throw" | "load-reject" | "policy") {
  const ipc = new EventEmitter();
  let parentDestroyed = false;
  let visible = true;
  let minimized = false;
  let frameDestroyed = false;
  let contentsDestroyed = false;
  let frameParent: object | null = null;
  let contentsURL: string | undefined;
  const parent = Object.assign(new EventEmitter(), {
    isDestroyed: () => parentDestroyed, isVisible: () => visible, isMinimized: () => minimized,
  });
  const windows: Window[] = [];
  const partitions: string[] = [];
  const sessions: ReturnType<typeof sessionFixture>[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  function sessionFixture() {
    const handlers = new Map<string, unknown>();
    let network: ((details: { url: string; method?: string; resourceType?: string; webContentsId?: number }, callback: (value: { cancel: boolean }) => void) => void) | null = null;
    let connectionsClosed = 0;
    let storageCleared = 0;
    const protocols = new Map<string, (request: { url: string; method: string }) => Response>();
    const ses = Object.assign(new EventEmitter(), {
      setPermissionCheckHandler: (value: unknown) => handlers.set("check", value),
      setPermissionRequestHandler: (value: unknown) => handlers.set("request", value),
      setDevicePermissionHandler: (value: unknown) => handlers.set("device", value),
      setDisplayMediaRequestHandler: (value: unknown) => handlers.set("display", value),
      webRequest: { onBeforeRequest: (value: typeof network) => { network = value; if (failure === "policy") throw new Error("policy"); } },
      closeAllConnections: async () => { connectionsClosed++; },
      clearStorageData: async () => { storageCleared++; },
      protocol: {
        handle: (scheme: string, handler: (request: { url: string; method: string }) => Response) => protocols.set(scheme, handler),
        unhandle: (scheme: string) => protocols.delete(scheme),
      },
    });
    return { ses, handlers, protocols, get network() { return network; }, get connectionsClosed() { return connectionsClosed; },
      get storageCleared() { return storageCleared; } };
  }
  class Window extends EventEmitter {
    destroyed = false;
    shown = 0;
    focused = 0;
    menuRemoved = false;
    loaded = "";
    frame = { url: "", get parent() { return frameParent; }, isDestroyed: () => frameDestroyed };
    contents = Object.assign(new EventEmitter(), {
      id: 100 + windows.length, mainFrame: this.frame, getURL: () => contentsURL ?? this.frame.url, isDestroyed: () => this.destroyed || contentsDestroyed,
      setWindowOpenHandler: (handler: () => { action: string }) => { this.popup = handler; },
    });
    webContents = this.contents;
    popup?: () => { action: string };
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super(); if (failure === "constructor") throw new Error("constructor"); windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown++; }
    focus() { this.focused++; }
    setMenu(value: unknown) { this.menuRemoved = value === null; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    loadURL(url: string) {
      if (failure === "load-throw") throw new Error("load");
      if (failure === "load-reject") return Promise.reject(new Error("load"));
      this.loaded = url;
      this.contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
      this.frame.url = url;
      return Promise.resolve();
    }
  }
  const module = { exports: { confirmExternalLink: (_options: { parent: unknown; url: string; signal: AbortSignal }): Promise<boolean> => Promise.resolve(false) } };
  const modules: Record<string, unknown> = {
    electron: { BrowserWindow: Window, nativeTheme: { shouldUseDarkColors: false }, ipcMain: ipc,
      session: { fromPartition: (partition: string) => {
        if (failure === "session") throw new Error("session");
        partitions.push(partition); const f = sessionFixture(); sessions.push(f); return f.ses;
      } } },
    "node:crypto": crypto, "node:path": path, "./external-link-document": document,
  };
  runInNewContext(compiled.stdout, { module, exports: module.exports, URL, Response, __dirname: "/test-dist", Buffer,
    require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const controller = new AbortController();
  const start = (url = "https://example.com:8443/path") => module.exports.confirmExternalLink({ parent, url, signal: controller.signal });
  const child = () => { const value = windows.at(-1); assert.ok(value, "child window created"); return value; };
  const token = () => {
    const arg = child().options.webPreferences?.additionalArguments?.find((value) => value.startsWith("--chat-external-link-token="));
    assert.ok(arg); return arg.slice("--chat-external-link-token=".length);
  };
  const answer = (...args: unknown[]) => ipc.emit("chat:external-link-choice", { sender: child().contents, senderFrame: child().frame }, ...args);
  return { parent, windows, partitions, sessions, ipc, controller, start, child, token, answer, timers,
    ready: () => child().emit("ready-to-show"),
    parentState: (state: { destroyed?: boolean; visible?: boolean; minimized?: boolean }) => {
      parentDestroyed = state.destroyed ?? parentDestroyed; visible = state.visible ?? visible; minimized = state.minimized ?? minimized;
    },
    senderState: (state: { frameDestroyed?: boolean; contentsDestroyed?: boolean; frameParent?: object | null; contentsURL?: string }) => {
      frameDestroyed = state.frameDestroyed ?? frameDestroyed; contentsDestroyed = state.contentsDestroyed ?? contentsDestroyed;
      if (state.frameParent !== undefined) frameParent = state.frameParent;
      contentsURL = state.contentsURL ?? contentsURL;
    } };
}

function assertClean(f: ReturnType<typeof fixture>) {
  assert.equal(f.ipc.listenerCount("chat:external-link-choice"), 0);
  assert.equal(f.timers.size, 0);
  for (const name of ["closed", "close", "hide", "minimize"]) assert.equal(f.parent.listenerCount(name), 0, name);
  for (const ses of f.sessions) {
    assert.equal(ses.network, null);
    assert.equal(ses.ses.listenerCount("will-download"), 0);
    assert.equal(ses.connectionsClosed, 1);
    assert.equal(ses.storageCleared, 1);
    assert.equal(ses.protocols.size, 0);
  }
  for (const child of f.windows) assert.equal(child.destroyed, true);
}

test("frameless opaque modal uses hardened preferences, private session, no menu, and waits for ready-to-show", async () => {
  const f = fixture(); const result = f.start(); const child = f.child();
  assert.equal(child.options.parent, f.parent);
  for (const [key, value] of Object.entries({ modal: true, frame: false, show: false, transparent: false, resizable: false })) {
    assert.equal(Reflect.get(child.options, key), value, key);
  }
  assert.equal(child.options.width, 500); assert.equal(child.options.height, 460);
  const prefs = child.options.webPreferences; assert.ok(prefs);
  for (const [key, value] of Object.entries({ contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false })) assert.equal(Reflect.get(prefs, key), value, key);
  assert.equal(prefs.preload, "/test-dist/external-link-preload.cjs");
  assert.equal(prefs.session, f.sessions[0]?.ses);
  assert.equal(f.partitions[0]?.startsWith("persist:"), false);
  assert.equal(child.menuRemoved, true);
  assert.equal(child.shown, 0); f.ready(); assert.equal(child.shown, 1);
  f.answer(f.token(), true); assert.equal(await result, true); assertClean(f);
});

test("only exact child/main-frame/document with private token and precisely one boolean can consent", async () => {
  const f = fixture(); const result = f.start(); f.ready(); const child = f.child();
  const valid = { sender: child.contents, senderFrame: child.frame };
  for (const event of [{ ...valid, sender: {} }, { ...valid, senderFrame: { ...child.frame } },
    { ...valid, senderFrame: null }]) f.ipc.emit("chat:external-link-choice", event, f.token(), true);
  for (const args of [[true], ["wrong", true], [f.token(), "true"], [f.token(), true, "extra"], [f.token()]]) f.answer(...args);
  assert.equal(child.destroyed, false);
  child.frame.url = "data:text/html,foreign"; f.answer(f.token(), true); assert.equal(child.destroyed, false);
  child.frame.url = child.loaded; f.answer(f.token(), false);
  assert.equal(await result, false); assertClean(f);
});

test("consent is ignored before ready, after parent becomes unavailable, and for changed webContents URL", async () => {
  const f = fixture(); const result = f.start();
  f.answer(f.token(), true); assert.equal(f.child().destroyed, false);
  f.ready(); f.parentState({ visible: false }); f.answer(f.token(), true);
  assert.equal(await result, false); assertClean(f);
});

for (const name of ["close", "closed", "hide", "minimize"]) {
  test(`parent ${name} cancels and completely cleans up`, async () => {
    const f = fixture(); const result = f.start(); f.ready(); f.parent.emit(name);
    assert.equal(await result, false); assertClean(f);
  });
}
for (const name of ["close", "closed", "unresponsive"]) {
  test(`child ${name} cancels`, async () => {
    const f = fixture(); const result = f.start(); f.ready(); f.child().emit(name);
    assert.equal(await result, false); assertClean(f);
  });
}
for (const name of ["destroyed", "did-fail-load", "render-process-gone", "preload-error", "did-navigate-in-page"]) {
  test(`child webContents ${name} cancels`, async () => {
    const f = fixture(); const result = f.start(); f.ready(); f.child().contents.emit(name);
    assert.equal(await result, false); assertClean(f);
  });
}
for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
  test(`${name} is prevented and cancels`, async () => {
    const f = fixture(); const result = f.start(); let prevented = false;
    f.child().contents.emit(name, { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true); assert.equal(await result, false); assertClean(f);
  });
}

test("initial exact main-frame navigation is allowed but even same-document reload/re-navigation cancels", async () => {
  const f = fixture(); const result = f.start();
  assert.equal(f.child().destroyed, false);
  f.child().contents.emit("did-start-navigation", { url: f.child().loaded, isMainFrame: true, isSameDocument: false });
  assert.equal(await result, false); assertClean(f);
});

test("isolated protocol serves only exact GET document, never exposes sensitive URL in load URL or arguments", async () => {
  const f = fixture(); const original = "https://example.com:8443/private?token=secret";
  const result = f.start(original); const child = f.child();
  assert.match(child.loaded, /^chat-external-link:\/\/dialog\/[a-f0-9]{64}$/);
  assert.ok(!child.loaded.includes("secret"));
  assert.ok(!child.options.webPreferences?.additionalArguments?.some((value) => value.includes(original)));
  const handler = f.sessions[0]?.protocols.get("chat-external-link"); assert.ok(handler);
  const response = handler({ url: child.loaded, method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("content-security-policy")?.includes("script-src 'none'"));
  assert.ok((await response.text()).includes("https://example.com:8443/private?token=secret"));
  for (const request of [{ url: child.loaded, method: "POST" }, { url: `${child.loaded}/foreign`, method: "GET" },
    { url: "chat-external-link://dialog/foreign", method: "GET" }]) assert.equal(handler(request).status, 403);
  f.controller.abort(); assert.equal(await result, false); assertClean(f);
});

test("destroyed frames, non-main parents and differing webContents URLs cannot consent", async () => {
  for (const state of [{ frameDestroyed: true }, { contentsDestroyed: true }, { frameParent: {} },
    { contentsURL: "chat-external-link://dialog/foreign" }]) {
    const f = fixture(); const result = f.start(); f.ready(); f.senderState(state); f.answer(f.token(), true);
    assert.equal(f.child().destroyed, false); f.controller.abort(); assert.equal(await result, false); assertClean(f);
  }
});

test("network permits only one exact local document GET for the child main frame", async () => {
  {
    const f = fixture(); const result = f.start(); const child = f.child(); const ses = f.sessions[0];
    assert.ok(ses?.network);
    const request = { url: child.loaded, method: "GET", resourceType: "mainFrame", webContentsId: child.contents.id };
    const decisions: boolean[] = [];
    const answer = (value: { cancel: boolean }) => decisions.push(value.cancel);
    for (const details of [{ ...request, url: "data:text/html;charset=utf-8,foreign" },
      { ...request, resourceType: "subFrame" }, { ...request, resourceType: "image" },
      { ...request, method: "POST" }, { ...request, webContentsId: 9999 }, { ...request, webContentsId: undefined }]) {
      ses.network(details, answer);
    }
    ses.network(request, answer); ses.network(request, answer);
    assert.deepEqual(decisions, [true, true, true, true, true, true, false, true]);
    f.controller.abort(); assert.equal(await result, false); assertClean(f);
  }
});

test("all network, permissions, display/device access, downloads and popups are denied", async () => {
  const f = fixture(); const result = f.start(); const ses = f.sessions[0]; assert.ok(ses);
  assert.ok(ses.network); const network: boolean[] = [];
  for (const url of ["https://attacker.example/", "file:///etc/passwd", "data:text/plain,test"]) {
    ses.network({ url }, (value) => network.push(value.cancel));
  }
  assert.deepEqual(network, [true, true, true]);
  const check = ses.handlers.get("check"); assert.ok(typeof check === "function"); assert.equal(check(), false);
  const device = ses.handlers.get("device"); assert.ok(typeof device === "function"); assert.equal(device(), false);
  const request = ses.handlers.get("request"); assert.ok(typeof request === "function");
  const answers: unknown[] = []; request({}, "media", (value: unknown) => answers.push(value));
  const display = ses.handlers.get("display"); assert.ok(typeof display === "function"); display({}, (value: unknown) => answers.push(value));
  assert.deepEqual(answers, [false, null]);
  let prevented = false; ses.ses.emit("will-download", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.child().popup?.().action, "deny");
  f.controller.abort(); assert.equal(await result, false); assertClean(f);
});

for (const input of [{ key: "Escape" }, { key: "w", control: true }, { key: "W", meta: true }]) {
  test(`native keyboard ${JSON.stringify(input)} cancels`, async () => {
    const f = fixture(); const result = f.start(); let prevented = false;
    f.child().contents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, { type: "keyDown", ...input });
    assert.equal(prevented, true); assert.equal(await result, false); assertClean(f);
  });
}

for (const failure of ["constructor", "session", "load-throw", "load-reject", "policy"]) {
  test(`${failure} fails closed without leaked listeners or preventing retry`, async () => {
    assert.ok(failure === "constructor" || failure === "session" || failure === "load-throw" || failure === "load-reject" || failure === "policy");
    const f = fixture(failure); assert.equal(await f.start(), false); assertClean(f);
    assert.equal(await f.start(), false); assertClean(f);
  });
}

test("aborted/unavailable parents create no child; pending load timeout cancels; retry has new session and token", async () => {
  for (const state of [{ destroyed: true }, { visible: false }, { minimized: true }]) {
    const f = fixture(); f.parentState(state); assert.equal(await f.start(), false); assert.equal(f.windows.length, 0);
  }
  const aborted = fixture(); aborted.controller.abort(); assert.equal(await aborted.start(), false); assert.equal(aborted.windows.length, 0);
  const f = fixture(); const first = f.start(); const oldToken = f.token(); const oldPartition = f.partitions[0];
  for (const timeout of [...f.timers.values()]) timeout(); assert.equal(await first, false); assertClean(f);
  const second = f.start(); f.ready(); assert.notEqual(f.token(), oldToken); assert.notEqual(f.partitions.at(-1), oldPartition);
  f.answer(oldToken, true); assert.equal(f.child().destroyed, false); f.answer(f.token(), true); assert.equal(await second, true); assertClean(f);
});
