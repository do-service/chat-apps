import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { serverSelectionContentSecurityPolicy, serverSelectionDocument } from "./server-selection-document";

test("initial and switching screens show accessible local controls and explicit restart risks", () => {
  const initial = serverSelectionDocument("https://chat.exz-vps.ru", false);
  assert.ok(initial.includes("Подключиться"));
  assert.ok(initial.includes('value="https://chat.exz-vps.ru"'));
  assert.ok(!initial.includes("Сохранить и перезапустить"));
  const switching = serverSelectionDocument("https://example.com/", true);
  for (const text of ["Сохранить и перезапустить", "звонок", "несохранённый текст", "перезапущено"]) assert.ok(switching.includes(text), text);
  for (const html of [initial, switching]) {
    for (const text of ['id="server-url"', 'id="server-error"', 'role="alert"', 'aria-describedby="server-hint server-error"',
      'id="server-confirm"', 'id="server-cancel"', "Отмена", "prefers-color-scheme: dark"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /<(?:a|script|iframe|img)\b|\bon\w+=|\b(?:src|href)=/i);
  }
});

test("document escapes hostile attributes and allows only its hashed style", () => {
  const html = serverSelectionDocument('\"><script>alert(1)</script>\u202e', false);
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
  assert.doesNotMatch(html, /<script>|\u202e/);
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]; assert.ok(style);
  const digest = createHash("sha256").update(style).digest("base64");
  for (const directive of ["default-src 'none'", "script-src 'none'", "base-uri 'none'", "form-action 'none'", `style-src 'sha256-${digest}'`]) {
    assert.ok(serverSelectionContentSecurityPolicy.includes(directive), directive);
  }
});

test("proxy form is local, accessible, defaults explicitly and preserves the server control", () => {
  const html = Reflect.apply(serverSelectionDocument, undefined, ["https://example.com/", false, {
    current: { mode: "https", scope: "all", host: '"><img src="bad">', port: 443 }, needsReset: true,
  }]);
  for (const text of ['id="server-url"', 'aria-label="Настройки прокси"', 'aria-controls="proxy-panel"',
    'id="proxy-panel"', 'value="default">По умолчанию', 'value="https" selected', 'value="all" selected',
    'for="proxy-host"', 'for="proxy-port"', 'id="proxy-error"', 'WebRTC', 'браузер',
    'Не удалось прочитать сохранённые настройки', '&lt;img', 'value="443"']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<(?:a|script|iframe|img)\b|formaction=/i);
  assert.doesNotMatch(serverSelectionDocument("https://example.com/", false), /id="proxy-/);
});
