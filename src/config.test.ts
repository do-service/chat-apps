import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseBuildConfiguration, resolveConfiguration } from "./config";
import { SPIKE_URL } from "./security";

test("committed app origin is the user-confirmed site and remains isolated from diagnostics", () => {
  const source: unknown = JSON.parse(readFileSync("app-config.json", "utf8"));
  const remote = resolveConfiguration([], undefined, source);
  assert.equal(remote.appURL, "https://chat.exz-vps.ru/");
  assert.equal(remote.trustedOrigin, "https://chat.exz-vps.ru");
  assert.equal(remote.spike, false);
  const diagnostic = resolveConfiguration(["--spike"], undefined, source);
  assert.equal(diagnostic.appURL, SPIKE_URL);
  assert.notEqual(remote.partition, diagnostic.partition);
});

test("remote mode fails closed with no URL or invalid configuration", () => {
  for (const config of [undefined, null, {}, { appUrl: null }, { appUrl: "https://chat.example/", extra: true }]) {
    assert.throws(() => resolveConfiguration([], undefined, config));
  }
  assert.throws(() => resolveConfiguration([], "", { appUrl: "https://chat.example/" }));
});

test("explicit spike needs neither environment nor build URL", () => {
  const config = resolveConfiguration(["--spike"], "invalid", undefined);
  assert.equal(config.spike, true);
  assert.equal(config.appURL, SPIKE_URL);
  assert.match(config.partition, /^persist:chat-desktop-v1-[a-f0-9]{64}$/);
  assert.equal(resolveConfiguration(["--spike=yes"], "https://chat.example/", undefined).spike, false);
});

test("build URL and explicit environment URL are validated origin roots", () => {
  assert.equal(parseBuildConfiguration({ appUrl: null }), null);
  assert.equal(parseBuildConfiguration({ appUrl: "https://chat.example" }), "https://chat.example/");
  const config = resolveConfiguration([], "https://explicit.example:8443/", { appUrl: "https://build.example/" });
  assert.equal(config.appURL, "https://explicit.example:8443/");
  assert.equal(config.trustedOrigin, "https://explicit.example:8443");
});

test("only an explicit diagnostic build marker enables cold-start spike without a launch flag", () => {
  const baked = resolveConfiguration([], "invalid ignored environment", { appUrl: null, spike: true });
  assert.equal(baked.spike, true);
  assert.equal(baked.appURL, SPIKE_URL);
  assert.equal(baked.partition, resolveConfiguration(["--spike"], undefined, undefined).partition);
  for (const value of [{ spike: true }, { appUrl: null, spike: false }, { appUrl: "https://chat.example/", spike: true },
    { appUrl: null, spike: "true" }, { appUrl: null, spike: true, extra: true }]) {
    assert.throws(() => resolveConfiguration([], "https://chat.example/", value));
  }
  assert.throws(() => resolveConfiguration([], undefined, { appUrl: null }));
});

test("persistent sessions and metadata are isolated by canonical origin including scheme and port", () => {
  const first = resolveConfiguration([], "https://chat.example", undefined);
  const same = resolveConfiguration([], "https://CHAT.EXAMPLE:443/", undefined);
  const changed = resolveConfiguration([], "https://chat.example:8443/", undefined);
  const spike = resolveConfiguration(["--spike"], undefined, undefined);
  assert.equal(first.partition, same.partition);
  assert.notEqual(first.profileKey, changed.profileKey);
  assert.notEqual(first.partition, spike.partition);
});
