import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AUTH_TTL_MS, AuthFailure, DesktopAuthService, generateAuthProof, validateSessionCookie, validateTransaction,
  type AuthAttemptPort, type AuthCookie, type AuthPath, type AuthResponse,
} from "./desktop-auth";
import type { DesktopAuthState } from "./contract";

const root = "https://chat.example/";
const verifier = "V".repeat(43);
const challenge = "C".repeat(43);
const transaction = {
  transaction_id: "T".repeat(43), authorization_url: `https://chat.example/auth/desktop/authorize?request=${"R".repeat(43)}`,
  user_code: "2345-BCDF", expires_in: 300, interval: 2,
};
const validCookie: AuthCookie = {
  name: "__Host-session", value: "S".repeat(43), domain: "chat.example", hostOnly: true,
  path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 10_000,
};
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
class FakeAttempt implements AuthAttemptPort {
  cookies: unknown[] = [];
  persistent: AuthCookie | undefined;
  calls: { path: AuthPath; body: unknown }[] = [];
  installs = 0;
  logouts = 0;
  disposals = 0;
  rollbacks = 0;
  verified = true;
  installFailure = false;
  createResponse: AuthResponse = { status: 201, body: transaction };
  exchange: () => Promise<AuthResponse> = async () => ({ status: 202, body: { status: "pending", interval: 2 } });
  ack: () => Promise<AuthResponse> = async () => ({ status: 204 });
  async post(path: AuthPath, body: unknown): Promise<AuthResponse> {
    this.calls.push({ path, body });
    if (path === "/auth/desktop/transactions") return this.createResponse;
    if (path === "/auth/desktop/exchange") return this.exchange();
    if (path === "/auth/desktop/ack") return this.ack();
    return { status: 204 };
  }
  async prepareCommit() {}
  async finishCommit() {}
  async readCookies() { return this.cookies; }
  async install(cookie: AuthCookie) { this.installs++; this.persistent = cookie; if (this.installFailure) throw new Error("disk-private-path"); }
  async verify() { return this.verified; }
  async rollback(cookie: AuthCookie) { this.rollbacks++; if (this.persistent?.value === cookie.value) this.persistent = undefined; }
  async logout() { this.logouts++; this.cookies = []; }
  async dispose() { this.disposals++; }
}
function fixture(attempts = [new FakeAttempt()]) {
  let now = 1_000_000;
  let opened = 0;
  let success = 0;
  let creations = 0;
  const states: DesktopAuthState[] = [];
  const sleeps: { duration: number; resolve(): void; signal: AbortSignal }[] = [];
  const service = new DesktopAuthService({
    appURL: root, platform: "darwin", enabled: true, proof: () => ({ verifier, challenge }), now: () => now,
    createAttempt: () => { const attempt = attempts[creations++]; assert.ok(attempt); return attempt; },
    openBrowser: async (url) => { assert.equal(url, transaction.authorization_url); opened++; },
    emit: (state) => states.push(state), onSuccess: () => { success++; },
    sleep: (duration, signal) => new Promise((resolve) => { sleeps.push({ duration, resolve, signal }); }),
  });
  return {
    service, states, opened: () => opened, success: () => success, creations: () => creations,
    setNow: (value: number) => { now = value; },
    async advance() { const sleep = sleeps.shift(); assert.ok(sleep); now += sleep.duration; sleep.resolve(); await flush(); return sleep.duration; },
  };
}

test("main generates independent 256-bit S256 proof; transaction URL/code/TTL schema is exact", () => {
  const one = generateAuthProof();
  const two = generateAuthProof();
  assert.match(one.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(one.verifier, two.verifier);
  assert.equal(one.challenge, createHash("sha256").update(one.verifier).digest("base64url"));
  assert.deepEqual(validateTransaction(transaction, root), transaction);
  for (const changed of [
    { authorization_url: transaction.authorization_url + "&token=x" }, { authorization_url: transaction.authorization_url.replace("chat.example", "chat.example.attacker.test") },
    { authorization_url: transaction.authorization_url.replace("/authorize?", "/authorize/?") },
    { authorization_url: `https://chat.example/auth/desktop/authorize?request=${transaction.transaction_id}` },
    { user_code: "1234-ABCD" }, { expires_in: 301 }, { interval: 0 }, { extra: "secret" },
  ]) assert.throws(() => validateTransaction({ ...transaction, ...changed }, root), AuthFailure);
});

test("only exact host-only secure HttpOnly lax persistent session cookie is accepted", () => {
  assert.deepEqual(validateSessionCookie(validCookie, root, 1_000_000), validCookie);
  for (const changed of [{ name: "session" }, { hostOnly: false }, { domain: ".chat.example" }, { domain: "other.example" },
    { path: "/auth" }, { httpOnly: false }, { secure: false }, { sameSite: "strict" }, { expirationDate: 1 }, { value: "token" }]) {
    assert.throws(() => validateSessionCookie({ ...validCookie, ...changed }, root, 1_000_000), AuthFailure);
  }
});

test("success installs fresh cookie, verifies and ACKs proof before emitting success; renderer never gets secrets", async () => {
  const attempt = new FakeAttempt();
  attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
  const ack = deferred<AuthResponse>();
  attempt.ack = () => ack.promise;
  const f = fixture([attempt]);
  assert.deepEqual(f.service.begin({ door: "guest" }), { status: "starting" });
  await flush();
  assert.equal(f.service.getState().status, "waiting");
  assert.equal(f.opened(), 1);
  await f.advance();
  assert.equal(f.service.getState().status, "committing");
  assert.equal(f.success(), 0);
  f.service.cancel();
  assert.equal(f.service.getState().status, "committing");
  assert.equal(f.service.begin({ door: "" }).status, "committing");
  assert.equal(f.creations(), 1);
  ack.resolve({ status: 204 });
  await flush();
  assert.equal(f.service.getState().status, "success");
  assert.equal(f.success(), 1);
  assert.equal(attempt.logouts, 0);
  assert.equal(attempt.installs, 1);
  assert.deepEqual(attempt.calls.find((call) => call.path === "/auth/desktop/ack")?.body, { transaction_id: transaction.transaction_id, code_verifier: verifier });
  const serialized = JSON.stringify(f.states);
  for (const secret of [verifier, transaction.transaction_id, transaction.authorization_url, validCookie.value]) assert.equal(serialized.includes(secret), false);
});

test("lost exchange response can recover cookie only from same fresh attempt jar, then ACK", async () => {
  const attempt = new FakeAttempt();
  attempt.exchange = async () => { attempt.cookies = [validCookie]; throw new Error("response lost"); };
  const f = fixture([attempt]);
  f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.equal(f.service.getState().status, "success");
  assert.equal(attempt.installs, 1);
  assert.equal(attempt.calls.filter((call) => call.path === "/auth/desktop/ack").length, 1);
});

test("consumed without same-attempt cookie fails closed instead of cloning another session", async () => {
  const attempt = new FakeAttempt();
  attempt.persistent = validCookie;
  attempt.exchange = async () => ({ status: 410, body: { status: "consumed" } });
  const f = fixture([attempt]);
  f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.deepEqual(f.service.getState(), { status: "error", code: "session-install-failed" });
  assert.equal(attempt.installs, 0);
  assert.ok(attempt.calls.some((call) => call.path === "/auth/desktop/cancel"));
});

test("cancelled late Set-Cookie cannot install or supersede a newer attempt; orphan cleanup repeats after response", async () => {
  const old = new FakeAttempt(); const newer = new FakeAttempt();
  const late = deferred<AuthResponse>();
  old.exchange = async () => { const response = await late.promise; old.cookies = [validCookie]; return response; };
  const f = fixture([old, newer]);
  f.service.begin({ door: "" }); await flush(); await f.advance();
  f.service.cancel();
  assert.equal(f.service.getState().status, "cancelled");
  f.service.begin({ door: "guest" }); await flush();
  const state = f.service.getState();
  late.resolve({ status: 204 }); await flush();
  assert.equal(old.installs, 0);
  assert.ok(old.logouts >= 2);
  assert.equal(old.cookies.length, 0);
  assert.deepEqual(f.service.getState(), state);
  assert.equal(f.success(), 0);
  f.service.cancel();
});

test("failed persistent install, verify or ACK rolls back only matching new cookie and revokes ephemeral grant", async () => {
  for (const failure of ["install", "verify", "ack", "newer-cookie"]) {
    const attempt = new FakeAttempt();
    attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
    if (failure === "install") attempt.installFailure = true;
    if (failure === "verify") attempt.verified = false;
    if (failure === "ack" || failure === "newer-cookie") attempt.ack = async () => {
      if (failure === "newer-cookie") attempt.persistent = { ...validCookie, value: "N".repeat(43) };
      return { status: 403 };
    };
    const f = fixture([attempt]);
    f.service.begin({ door: "" }); await flush(); await f.advance();
    assert.equal(f.service.getState().status, "error");
    assert.equal(f.success(), 0);
    assert.ok(attempt.logouts > 0);
    assert.ok(attempt.calls.some((call) => call.path === "/auth/desktop/cancel"));
    assert.equal(attempt.persistent?.value, failure === "newer-cookie" ? "N".repeat(43) : undefined);
  }
});

test("lost ACK response is retried idempotently; cancellation cannot interrupt commit or release barrier early", async () => {
  const attempt = new FakeAttempt();
  let prepared = false; let released = false; let acknowledgements = 0;
  attempt.prepareCommit = async () => { prepared = true; };
  attempt.finishCommit = async () => { released = true; };
  attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
  attempt.ack = async () => { acknowledgements++; if (acknowledgements === 1) throw new Error("lost ACK"); return { status: 204 }; };
  const f = fixture([attempt]);
  f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.equal(prepared, true); assert.equal(released, false);
  f.service.cancel(); assert.equal(f.service.getState().status, "committing");
  await f.advance();
  assert.equal(acknowledgements, 2); assert.equal(released, true);
  assert.equal(f.service.getState().status, "success");
});

test("ACK slow_down retries after bounded Retry-After then succeeds without rollback or early barrier release", async () => {
  const attempt = new FakeAttempt();
  let acknowledgements = 0; let released = false;
  attempt.finishCommit = async () => { released = true; };
  attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
  attempt.ack = async () => ++acknowledgements === 1
    ? { status: 429, body: { status: "slow_down" }, retryAfter: 4 } : { status: 204 };
  const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.equal(f.service.getState().status, "committing");
  assert.equal(attempt.installs, 1); assert.equal(released, false); assert.equal(attempt.rollbacks, 0);
  assert.equal(await f.advance(), 4000);
  assert.equal(acknowledgements, 2); assert.equal(f.service.getState().status, "success");
  assert.equal(attempt.rollbacks, 0); assert.equal(released, true);
});

test("ACK slow_down cannot retry past remaining TTL and rolls back the provisional cookie", async () => {
  const attempt = new FakeAttempt(); let acknowledgements = 0;
  attempt.createResponse = { status: 201, body: { ...transaction, expires_in: 3 } };
  attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
  attempt.ack = async () => { acknowledgements++; return { status: 429, body: { status: "slow_down" }, retryAfter: 30 }; };
  const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.equal(f.service.getState().status, "committing");
  assert.equal(await f.advance(), 1000);
  assert.equal(acknowledgements, 1); assert.equal(f.success(), 0);
  assert.deepEqual(f.service.getState(), { status: "error", code: "auth-failed" });
  assert.equal(attempt.rollbacks, 1); assert.equal(attempt.persistent, undefined);
});

test("malformed ACK rate-limit responses fail closed without retry", async () => {
  for (const response of [
    { status: 429, body: { status: "other" }, retryAfter: 2 },
    { status: 429, body: { status: "slow_down", extra: "not-allowed" }, retryAfter: 2 },
    { status: 429, body: { status: "slow_down" }, retryAfter: 0 },
    { status: 429, body: { status: "slow_down" }, retryAfter: 31 },
    { status: 429, body: { status: "slow_down" }, retryAfter: NaN },
  ]) {
    const attempt = new FakeAttempt(); let acknowledgements = 0;
    attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
    attempt.ack = async () => { acknowledgements++; return response; };
    const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
    assert.equal(acknowledgements, 1);
    assert.deepEqual(f.service.getState(), { status: "error", code: "invalid-response" });
    assert.equal(attempt.rollbacks, 1);
  }
});

test("ACK transport parser rejecting malformed response is not mistaken for a lost network reply", async () => {
  const attempt = new FakeAttempt(); let acknowledgements = 0;
  attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
  attempt.ack = async () => { acknowledgements++; throw new AuthFailure("invalid-response"); };
  const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.equal(acknowledgements, 1);
  assert.deepEqual(f.service.getState(), { status: "error", code: "invalid-response" });
  assert.equal(attempt.rollbacks, 1);
});

test("ACK slow_down remains bounded to three attempts even with ample TTL", async () => {
  const attempt = new FakeAttempt(); let acknowledgements = 0;
  attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
  attempt.ack = async () => { acknowledgements++; return { status: 429, body: { status: "slow_down" }, retryAfter: 2 }; };
  const f = fixture([attempt]); f.service.begin({ door: "" }); await flush();
  await f.advance(); await f.advance(); await f.advance();
  assert.equal(acknowledgements, 3);
  assert.deepEqual(f.service.getState(), { status: "error", code: "auth-failed" });
  assert.equal(attempt.rollbacks, 1); assert.equal(f.success(), 0);
});

test("commit preparation failure releases barrier after cleanup and never installs a cookie", async () => {
  const attempt = new FakeAttempt();
  let released = false;
  attempt.prepareCommit = async () => { throw new AuthFailure("session-install-failed"); };
  attempt.finishCommit = async () => { assert.ok(attempt.logouts > 0); released = true; };
  attempt.exchange = async () => { attempt.cookies = [validCookie]; return { status: 204 }; };
  const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.equal(attempt.installs, 0); assert.equal(released, true);
  assert.deepEqual(f.service.getState(), { status: "error", code: "session-install-failed" });
});

test("unsupported/invalid server never opens a browser and never falls back to embedded login", async () => {
  for (const response of [{ status: 404 }, { status: 503 }, { status: 201, body: { ...transaction, authorization_url: "https://idp.example/" } }]) {
    const attempt = new FakeAttempt(); attempt.createResponse = response;
    const f = fixture([attempt]); f.service.begin({ door: "" }); await flush();
    assert.equal(f.service.getState().status, "error"); assert.equal(f.opened(), 0); assert.equal(attempt.installs, 0);
  }
});

test("denied/expired/cancelled terminal status, minimum intervals and TTL are locally bounded", async () => {
  for (const [status, body] of [[403, "denied"], [410, "expired"], [410, "cancelled"]] satisfies [number, string][]) {
    const attempt = new FakeAttempt(); attempt.exchange = async () => ({ status, body: { status: body } });
    const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
    assert.equal(f.service.getState().status, body); assert.equal(attempt.installs, 0);
  }
  const f = fixture(); f.service.begin({ door: "" }); await flush();
  f.setNow(1_000_000 + AUTH_TTL_MS); await f.advance();
  assert.equal(f.service.getState().status, "expired");
});

test("transport failure without staged cookie retries at bounded interval, then can complete", async () => {
  const attempt = new FakeAttempt(); let calls = 0;
  attempt.exchange = async () => {
    calls++;
    if (calls === 1) throw new Error("network lost before cookie");
    attempt.cookies = [validCookie]; return { status: 204 };
  };
  const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
  assert.equal(f.service.getState().status, "waiting"); assert.equal(attempt.installs, 0);
  await f.advance(); assert.equal(calls, 2); assert.equal(f.service.getState().status, "success");
});

test("independent TTL expires even when system browser launch promise never settles", async () => {
  const attempt = new FakeAttempt();
  const never = new Promise<void>(() => {});
  const scheduled: { callback(): void; cancelled: boolean }[] = [];
  const service = new DesktopAuthService({
    appURL: root, platform: "darwin", enabled: true, createAttempt: () => attempt,
    openBrowser: () => never, emit: () => {}, onSuccess: () => {}, now: () => 1_000_000,
    schedule: (callback) => {
      const timer = { callback, cancelled: false }; scheduled.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  service.begin({ door: "" }); await flush();
  assert.equal(service.getState().status, "waiting");
  const timer = scheduled.filter((entry) => !entry.cancelled).at(-1); assert.ok(timer);
  timer.callback(); await flush();
  assert.equal(service.getState().status, "expired"); assert.equal(attempt.installs, 0);
  assert.ok(attempt.calls.some((call) => call.path === "/auth/desktop/cancel"));
});

test("network retry is bounded by TTL and disposal while exchange pending cannot install", async () => {
  const attempt = new FakeAttempt(); const late = deferred<AuthResponse>();
  attempt.exchange = () => late.promise;
  const f = fixture([attempt]); f.service.begin({ door: "" }); await flush(); await f.advance();
  f.service.dispose(); attempt.cookies = [validCookie]; late.resolve({ status: 204 }); await flush();
  assert.equal(attempt.installs, 0); assert.equal(f.success(), 0);
});
