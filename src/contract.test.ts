import test from "node:test";
import assert from "node:assert/strict";
import { isAuthState, isBadgeCount, isIdentifier, isLoginRequest, isNotificationDismissal, isNotificationKey, isNotificationRequest, isRoute } from "./contract";

const valid = {
  id: "event-1", accountId: "account-1", kind: "message", title: "Привет", body: "Новое сообщение",
  route: { chatId: "chat-1" }, silent: true, expiresAt: 1793966400000,
};

test("notification contract accepts only a bounded structured payload", () => {
  assert.equal(isNotificationRequest(valid), true);
  assert.equal(isNotificationRequest({ ...valid, kind: "call", route: { chatId: "chat-1", callId: "call-1" } }), true);
  for (const invalid of [null, [], {}, { ...valid, title: "" }, { ...valid, title: "x".repeat(257) },
    { ...valid, body: "x".repeat(2049) }, { ...valid, silent: 1 }, { ...valid, expiresAt: Infinity },
    { ...valid, expiresAt: 1.1 }, { ...valid, expiresAt: -1 }, { ...valid, kind: "execute" },
    { ...valid, id: "../file" }, { ...valid, accountId: "" }, { ...valid, extra: "not allowed" },
    { ...valid, route: { chatId: "chat-1", url: "https://attacker.test" } },
    { ...valid, route: { chatId: "chat-1", callId: "javascript:alert(1)" } }]) {
    assert.equal(isNotificationRequest(invalid), false);
  }
});

test("route and identifier contract never carries arbitrary URLs or paths", () => {
  for (const value of ["abc-DEF_123", "f3f6cf3d-e1db-416b-877c-fa967d84fd25", "x".repeat(128)]) assert.equal(isIdentifier(value), true);
  for (const value of ["", "x".repeat(129), "http://host", "..", "file/path", "chat?token=1", "чат", 5]) assert.equal(isIdentifier(value), false);
  assert.equal(isRoute({ chatId: "chat" }), true);
  assert.equal(isRoute({ chatId: "chat", url: "/" }), false);
  assert.equal(isRoute({ chatId: "chat", callId: null }), false);
});

test("auth bridge accepts only bounded door and credential-free discriminated state", () => {
  for (const door of ["", "main", "guest", "custom-door_1"]) assert.equal(isLoginRequest({ door }), true);
  for (const value of [{ door: "/" }, { door: "https://idp.example" }, { door: "x".repeat(65) }, {}, { door: "", verifier: "secret" }, null]) {
    assert.equal(isLoginRequest(value), false);
  }
  for (const state of [{ status: "idle" }, { status: "committing" }, { status: "waiting", userCode: "2345-BCDF", expiresAt: 12345678 },
    { status: "error", code: "unsupported-server" }]) assert.equal(isAuthState(state), true);
  for (const state of [{ status: "waiting", userCode: "1234-ABCD", expiresAt: 5 }, { status: "waiting", userCode: "2345-BCDF", expiresAt: Infinity },
    { status: "success", cookie: "secret" }, { status: "idle", transaction_id: "secret" }, { status: "error", code: "raw-url-error" },
    { status: "error", code: "network", details: "secret" }]) assert.equal(isAuthState(state), false);
});

test("scoped dismissal selectors accept exact bounded account/message/call schemas", () => {
  const message = { accountId: "alice", kind: "message", chatId: "chat_1", throughMessageId: 0 };
  const call = { accountId: "alice", kind: "call", callId: "call_1" };
  const reconcile = { accountId: "alice", kind: "call", exceptCallIds: ["call_1", "call_2"] };
  for (const value of [message, { ...message, throughMessageId: Number.MAX_SAFE_INTEGER }, call,
    reconcile, { ...reconcile, exceptCallIds: [] },
    { ...reconcile, exceptCallIds: Array.from({ length: 100 }, (_, index) => `call_${index}`) }]) {
    assert.equal(isNotificationDismissal(value), true);
  }
  for (const value of [null, [], {}, { ...message, accountId: "../alice" }, { ...message, chatId: "" },
    ...[-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined].map((throughMessageId) => ({ ...message, throughMessageId })),
    { ...message, extra: true }, { ...message, callId: "call_1" }, { ...message, kind: "test" },
    { accountId: "alice", kind: "message", chatId: "chat_1" },
    { ...call, callId: "https://bad" }, { ...call, chatId: "chat_1" }, { ...call, throughMessageId: 1 },
    { accountId: "alice", kind: "call" }, { ...call, exceptCallIds: [] },
    ...[null, "call_1", ["../call"], ["call_1", "call_1"], [1], [""], Array(1),
      Array.from({ length: 101 }, (_, index) => `call_${index}`)].map((exceptCallIds) => ({ ...reconcile, exceptCallIds })),
    { ...reconcile, extra: true }, { ...reconcile, accountId: "" }]) {
    assert.equal(isNotificationDismissal(value), false);
  }
});

test("close keys and badge counts are strict and bounded", () => {
  assert.equal(isNotificationKey({ id: "event", accountId: "account" }), true);
  assert.equal(isNotificationKey({ id: "event", accountId: "account", path: "/" }), false);
  assert.equal(isNotificationKey({ id: "event" }), false);
  for (const value of [0, 1, 999999]) assert.equal(isBadgeCount(value), true);
  for (const value of [-1, 1.5, Infinity, NaN, 1000000, "1", null]) assert.equal(isBadgeCount(value), false);
});
