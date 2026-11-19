import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultProxySettings, parseProxySettings, proxyRoutes, readProxySettings, writeProxySettings } from "./proxy-settings";

test("default preserves existing routes; check scope never affects chat or download", () => {
  assert.deepEqual(proxyRoutes(defaultProxySettings), { restrictWebRTC: false });
  assert.deepEqual(proxyRoutes({ mode: "system", scope: "check" }), { metadata: { mode: "system" }, restrictWebRTC: false });
  assert.deepEqual(proxyRoutes({ mode: "direct", scope: "all" }), {
    chat: { mode: "direct" }, metadata: { mode: "direct" }, download: { mode: "direct" }, restrictWebRTC: false,
  });
});

test("all scope covers native chat and both stages of updates without an implicit direct bypass", () => {
  for (const mode of ["http", "https", "socks5"] as const) {
    const proxy = { mode: "fixed_servers", proxyRules: `${mode}://[::1]:1080`, proxyBypassRules: "<-loopback>" };
    assert.deepEqual(proxyRoutes(parseProxySettings({ mode, scope: "all", host: "::1", port: 1080 })), {
      chat: proxy, metadata: proxy, download: proxy, restrictWebRTC: true,
    });
  }
  assert.equal(proxyRoutes({ mode: "system", scope: "all" }).restrictWebRTC, true);
});

test("only a hostname or IP and a valid numeric port can become proxy rules", () => {
  assert.deepEqual(parseProxySettings({ mode: "https", scope: "check", host: " Example.COM ", port: 65535 }),
    { mode: "https", scope: "check", host: "example.com", port: 65535 });
  for (const host of ["", "user:pw@host", "http://host", "host:3128", "host;direct://", "a,b", "a=foo", "host/path", "host#id", "host?query", "[bad]", "x\ty", "a..b", "999.999.999.999"]) {
    assert.throws(() => parseProxySettings({ mode: "http", scope: "all", host, port: 3128 }));
  }
  for (const port of [0, -1, 65536, 1.5, "1080", NaN]) {
    assert.throws(() => parseProxySettings({ mode: "socks5", scope: "all", host: "localhost", port }));
  }
  assert.throws(() => parseProxySettings({ mode: "system", scope: "all", password: "not-accepted" }));
});

test("settings round trip atomically; damaged data is distinguishable from an absent file", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-proxy-test-"));
  try {
    const path = join(dir, "proxy-settings.json");
    assert.deepEqual(readProxySettings(path), defaultProxySettings);
    const settings = { mode: "http", scope: "all", host: "localhost", port: 3128 };
    assert.deepEqual(writeProxySettings(path, settings), settings);
    assert.deepEqual(readProxySettings(path), settings);
    assert.throws(() => writeProxySettings(path, { ...settings, port: 0 }));
    assert.deepEqual(readProxySettings(path), settings);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
    writeFileSync(path, " ".repeat(20_000));
    assert.throws(() => readProxySettings(path));
    writeFileSync(path, "{\"version\":2}");
    assert.throws(() => readProxySettings(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
