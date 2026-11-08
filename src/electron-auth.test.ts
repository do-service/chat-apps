import assert from "node:assert/strict";
import test from "node:test";
import type { Cookie } from "electron";
import { CookieWriteBarrier, boundedJSON, createElectronAuthAttempt, type AuthSessionPort } from "./electron-auth";
import { AuthFailure, DesktopAuthService, type AuthCookie } from "./desktop-auth";

const root = "https://chat.example/";
const cookie: AuthCookie = {
  name: "__Host-session", value: "S".repeat(43), domain: "chat.example", hostOnly: true,
  path: "/", httpOnly: true, secure: true, sameSite: "lax", expirationDate: Date.now() / 1000 + 3600,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
class FakeSession implements AuthSessionPort {
  stored: Cookie[] = [];
  calls: { url: string; init: RequestInit }[] = [];
  setDetails: Electron.CookiesSetDetails[] = [];
  removed = 0;
  cleared = 0;
  closed = 0;
  flushes = 0;
  fetchReply: (url: string, init: RequestInit) => Promise<Response> = async () => new Response(null, { status: 204 });
  cookies: AuthSessionPort["cookies"] = {
    get: async (filter) => this.stored.filter((value) => !filter.name || value.name === filter.name).map((value) => ({ ...value })),
    set: async (details) => {
      this.setDetails.push(details);
      this.stored = [{ ...cookie, value: details.value ?? "", expirationDate: details.expirationDate }];
    },
    remove: async (_url, name) => { this.removed++; this.stored = this.stored.filter((value) => value.name !== name); },
    flushStore: async () => { this.flushes++; },
  };
  async fetch(url: string, init: RequestInit) { this.calls.push({ url, init }); return this.fetchReply(url, init); }
  async clearStorageData() { this.cleared++; this.stored = []; }
  async closeAllConnections() { this.closed++; }
}

test("cookie barrier rejects old/during-commit/unowned and redirected responses even after new generation reload", () => {
  const barrier = new CookieWriteBarrier();
  const headers = { "Set-Cookie": ["private-session"], "set-cookie": ["other-private-session"], "Content-Type": ["text/html"] };
  barrier.start(1, true);
  assert.equal(barrier.allows(1), true);
  const release = barrier.begin();
  barrier.start(2, true);
  assert.deepEqual(barrier.headers(1, headers), { "Content-Type": ["text/html"] });
  assert.equal(barrier.allows(2), false);
  release();
  barrier.start(3, true);
  barrier.start(4, false);
  barrier.start(1, true); // A late redirect must keep its original generation.
  for (const id of [1, 2, 4, 99]) assert.equal(barrier.allows(id), false);
  assert.equal(barrier.headers(3, headers), headers);
  const nextRelease = barrier.begin(); nextRelease();
  assert.equal(barrier.allows(3), false);
  barrier.end(1); barrier.start(5, true);
  assert.equal(barrier.allows(5), true);
});

test("late old network cookie cannot overwrite installed cookie or a newer generation's session", async () => {
  const app = new FakeSession(); const ephemeral = new FakeSession();
  const barrier = new CookieWriteBarrier();
  barrier.start(1, true); // Old renderer request is in flight before commit.
  let release = () => {};
  const port = createElectronAuthAttempt(root, app, ephemeral, {
    prepare: async () => { release = barrier.begin(); }, finish: () => release(),
  });
  const deliver = (id: number, value: string) => {
    const filtered = barrier.headers(id, { "Set-Cookie": [value] });
    if (filtered["Set-Cookie"]) app.stored = [{ ...cookie, value }];
  };
  await port.prepareCommit?.();
  await port.install(cookie);
  deliver(1, "O".repeat(43));
  assert.equal(app.stored[0]?.value, cookie.value);
  await port.finishCommit?.();
  barrier.start(2, true); deliver(2, "N".repeat(43)); // Fresh renderer after reload may renew normally.
  deliver(1, "O".repeat(43));
  assert.equal(app.stored[0]?.value, "N".repeat(43));
  await port.rollback(cookie);
  assert.equal(app.stored[0]?.value, "N".repeat(43));
});

test("native requests use exact origin, credentials include, JSON proof body and redirect:error", async () => {
  const app = new FakeSession(); const ephemeral = new FakeSession();
  const port = createElectronAuthAttempt(root, app, ephemeral);
  await port.post("/auth/desktop/exchange", { transaction_id: "T".repeat(43), code_verifier: "V".repeat(43) }, new AbortController().signal);
  const call = ephemeral.calls[0]; assert.ok(call);
  assert.equal(call.url, "https://chat.example/auth/desktop/exchange");
  assert.equal(call.init.redirect, "error"); assert.equal(call.init.credentials, "include");
  assert.deepEqual(call.init.headers, { Origin: "https://chat.example", "Content-Type": "application/json", Accept: "application/json" });
  assert.equal(call.url.includes("code_verifier"), false);
  assert.equal(app.calls.length, 0);
});

test("ACK HTTP Retry-After must be bounded integer seconds when present", async () => {
  for (const retryAfter of ["0", "31", "invalid", "2000", "2.5"]) {
    const app = new FakeSession(); const ephemeral = new FakeSession();
    ephemeral.fetchReply = async () => new Response(JSON.stringify({ status: "slow_down" }), {
      status: 429, headers: { "Content-Type": "application/json", "Retry-After": retryAfter },
    });
    const port = createElectronAuthAttempt(root, app, ephemeral);
    await assert.rejects(port.post("/auth/desktop/ack", {}, new AbortController().signal),
      (error: unknown) => error instanceof AuthFailure && error.code === "invalid-response");
  }
});

test("cookie commit omits Domain and verifies only matching persistent cookie using authenticated api/me", async () => {
  const app = new FakeSession(); const ephemeral = new FakeSession(); ephemeral.stored = [cookie];
  app.fetchReply = async () => json({ id: "01234567-89ab-cdef-0123-456789abcdef", profile: {} });
  const port = createElectronAuthAttempt(root, app, ephemeral);
  assert.equal((await port.readCookies()).length, 1);
  await port.install(cookie);
  const details = app.setDetails[0]; assert.ok(details);
  assert.equal(details.domain, undefined); assert.equal(details.httpOnly, true); assert.equal(details.secure, true);
  assert.equal(details.path, "/"); assert.equal(details.sameSite, "lax");
  assert.equal(await port.verify(cookie), true);
  assert.equal(app.calls[0]?.url, "https://chat.example/api/me");
  assert.equal(app.calls[0]?.init.redirect, "error");
  assert.ok(app.flushes > 0);
});

test("newer persistent login/logout cannot be overwritten or removed by older attempt cleanup", async () => {
  const app = new FakeSession(); const ephemeral = new FakeSession();
  app.stored = [{ ...cookie, value: "O".repeat(43) }];
  const port = createElectronAuthAttempt(root, app, ephemeral);
  await Promise.resolve();
  app.stored = [{ ...cookie, value: "N".repeat(43) }];
  await assert.rejects(port.install(cookie), AuthFailure);
  await port.rollback(cookie);
  assert.equal(app.removed, 0);
  assert.equal(app.stored[0]?.value, "N".repeat(43));
  app.stored = [];
  await assert.rejects(port.install(cookie), AuthFailure);
});

test("rollback removes only newly matching cookie and cleanup uses ephemeral logout, never persistent logout", async () => {
  const app = new FakeSession(); const ephemeral = new FakeSession();
  const port = createElectronAuthAttempt(root, app, ephemeral);
  await port.install(cookie); await port.rollback(cookie);
  assert.equal(app.removed, 1);
  await port.logout(); await port.dispose();
  assert.equal(ephemeral.calls[0]?.url, "https://chat.example/auth/logout");
  assert.equal(app.calls.length, 0); assert.equal(app.cleared, 0);
  assert.equal(ephemeral.closed, 1); assert.equal(ephemeral.cleared, 1);
  await assert.rejects(port.install(cookie), AuthFailure);
});

test("bounded JSON rejects HTML, malformed JSON and oversized streaming bodies without reflecting secrets", async () => {
  for (const response of [new Response("<html>secret</html>"), new Response("secret", { headers: { "content-type": "application/json" } }),
    json({ secret: "x".repeat(5000) })]) {
    await assert.rejects(boundedJSON(response), (error: unknown) => error instanceof AuthFailure && error.message === "invalid-response");
  }
});

test("lost exchange response stages cookie solely in ephemeral session and successful ACK precedes app success", async () => {
  const app = new FakeSession(); const ephemeral = new FakeSession();
  let acked = false;
  let successes = 0;
  const handle = "R".repeat(43);
  ephemeral.fetchReply = async (url) => {
    if (url.endsWith("/transactions")) return json({ transaction_id: "T".repeat(43), authorization_url: `https://chat.example/auth/desktop/authorize?request=${handle}`, user_code: "2345-BCDF", expires_in: 300, interval: 2 }, 201);
    if (url.endsWith("/exchange")) { ephemeral.stored = [cookie]; throw new Error("lost response secret URL must not escape"); }
    if (url.endsWith("/ack")) { assert.equal(ephemeral.stored[0]?.value, cookie.value); assert.equal(app.stored[0]?.value, cookie.value); acked = true; }
    return new Response(null, { status: 204 });
  };
  app.fetchReply = async () => json({ id: "01234567-89ab-cdef-0123-456789abcdef" });
  const service = new DesktopAuthService({
    appURL: root, platform: "darwin", enabled: true, createAttempt: () => createElectronAuthAttempt(root, app, ephemeral),
    openBrowser: async () => {}, emit: () => {}, sleep: async () => {},
    onSuccess: () => { assert.equal(acked, true); successes++; },
  });
  service.begin({ door: "" });
  for (let count = 0; count < 12 && service.getState().status !== "success"; count++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(service.getState().status, "success"); assert.equal(successes, 1);
  assert.equal(ephemeral.stored.length, 0);
  assert.equal(app.stored[0]?.value, cookie.value);
});
