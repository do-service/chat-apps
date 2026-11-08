import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR_ORIGIN, ERROR_URL, SPIKE_ORIGIN, TRUSTED_ORIGIN_ARGUMENT, externalHTTPSURL,
  isAllowedFrameNavigation, isTrustedSender, isTrustedURL, loginNavigationDoor,
  spikeResource, trustedOriginFromArguments, validateAppURL,
} from "./security";

const origin = "https://chat.example";

test("only an explicit credential-free HTTPS origin root is accepted", () => {
  assert.equal(validateAppURL("https://CHAT.example:443"), `${origin}/`);
  for (const value of [null, "", "http://chat.example/", "https://user:secret@chat.example/",
    "https://chat.example/path", "https://chat.example/?token=x", "https://chat.example/#",
    "https://chat.example?", " https://chat.example", "https://chat.example\\evil",
    "https://chat.example/a/..", "https://chat.example/%2e%2e/", "https://chat.example/\n"]) {
    assert.throws(() => validateAppURL(value));
  }
});

test("navigation and bridge checks use exact origin and reject opaque documents", () => {
  assert.equal(isTrustedURL(`${origin}/chat?q=one#two`, origin), true);
  for (const url of ["https://chat.example.attacker.test/", "https://chat.example:8443/",
    "http://chat.example/", "https://user@chat.example/", "about:blank",
    "blob:https://chat.example/id", "data:text/html,x", "file:///etc/passwd"]) {
    assert.equal(isTrustedURL(url, origin), false, url);
  }
  const sender = { expectedContents: true, mainFrame: true, frameOrigin: origin, frameURL: `${origin}/` };
  assert.equal(isTrustedSender(sender, origin), true);
  assert.equal(isTrustedSender({ ...sender, expectedContents: false }, origin), false);
  assert.equal(isTrustedSender({ ...sender, mainFrame: false }, origin), false);
  assert.equal(isTrustedSender({ ...sender, frameOrigin: "null" }, origin), false);
  assert.equal(isTrustedSender({ ...sender, frameURL: "about:blank" }, origin), false);
});

test("fixed recovery document is allowed only as exact main-frame navigation, never as a bridge origin", () => {
  for (const trustedOrigin of [origin, SPIKE_ORIGIN]) {
    assert.equal(isAllowedFrameNavigation(ERROR_URL, trustedOrigin, true), true);
    assert.equal(isAllowedFrameNavigation(ERROR_URL, trustedOrigin, false), false);
    for (const url of [`${ERROR_URL}path`, `${ERROR_URL}?retry=1`, `${ERROR_URL}#fragment`,
      `${ERROR_ORIGIN}:123/`, "chat-desktop-error://other/", "chat-desktop-error://user@app/",
      "chat-desktop-error://app/%2e%2e/", "file:///tmp/error.html", "https://foreign.example/"]) {
      assert.equal(isAllowedFrameNavigation(url, trustedOrigin, true), false, url);
      assert.equal(isAllowedFrameNavigation(url, trustedOrigin, false), false, url);
    }
    assert.equal(isTrustedURL(ERROR_URL, trustedOrigin), false);
    assert.equal(isTrustedSender({ expectedContents: true, mainFrame: true, frameOrigin: ERROR_ORIGIN, frameURL: ERROR_URL }, trustedOrigin), false);
  }
  assert.equal(isAllowedFrameNavigation(`${origin}/chat`, origin, true), true);
  assert.equal(isAllowedFrameNavigation(`${origin}/chat`, origin, false), true);
});

test("legacy login interception is exact same-origin top-frame only, no embedded IdP shortcut", () => {
  assert.equal(loginNavigationDoor(`${origin}/auth/login`, origin, true), "");
  assert.equal(loginNavigationDoor(`${origin}/auth/login/guest`, origin, true), "guest");
  for (const value of [`${origin}/auth/login/`, `${origin}/auth/login/guest/extra`, `${origin}/auth/login?next=evil`,
    `${origin}/auth/login#secret`, `${origin}/auth/login/%67uest`, `${origin}/auth/callback`,
    "https://chat.example.attacker.test/auth/login", "https://idp.example/auth/login", "http://chat.example/auth/login"]) {
    assert.equal(loginNavigationDoor(value, origin, true), null);
  }
  assert.equal(loginNavigationDoor(`${origin}/auth/login`, origin, false), null);
});

test("preload configuration rejects missing, duplicate and invalid trusted origins", () => {
  assert.equal(trustedOriginFromArguments([]), null);
  assert.equal(trustedOriginFromArguments([`${TRUSTED_ORIGIN_ARGUMENT}${origin}`]), origin);
  assert.equal(trustedOriginFromArguments([`${TRUSTED_ORIGIN_ARGUMENT}${SPIKE_ORIGIN}`]), SPIKE_ORIGIN);
  assert.equal(trustedOriginFromArguments([`${TRUSTED_ORIGIN_ARGUMENT}${origin}/auth`]), null);
  assert.equal(trustedOriginFromArguments([`${TRUSTED_ORIGIN_ARGUMENT}${origin}`, `${TRUSTED_ORIGIN_ARGUMENT}${origin}`]), null);
});

test("external links allow HTTPS only, never same-origin cookie-auth resources", () => {
  assert.equal(externalHTTPSURL("https://docs.example/guide", origin), "https://docs.example/guide");
  for (const url of [`${origin}/api/files/1`, "javascript:alert(1)", "mailto:a@example.com", "file:///tmp/x",
    "https://name:password@docs.example/", "http://docs.example/", "https://docs.example/\n"]) {
    assert.equal(externalHTTPSURL(url, origin), null);
  }
});

test("diagnostic protocol serves exactly three fixed resources, no path traversal or remote proxy", () => {
  assert.equal(spikeResource(`${SPIKE_ORIGIN}/`)?.file, "index.html");
  assert.equal(spikeResource(`${SPIKE_ORIGIN}/spike.js`)?.file, "spike.js");
  assert.equal(spikeResource(`${SPIKE_ORIGIN}/spike.css`)?.file, "spike.css");
  for (const url of ["chat-spike://evil/", `${SPIKE_ORIGIN}/../index.html`, `${SPIKE_ORIGIN}/%2e%2e/main.cjs`,
    `${SPIKE_ORIGIN}/spike.js?x=1`, `${SPIKE_ORIGIN}/spike.js/`, `${SPIKE_ORIGIN}/%73pike.js`,
    "chat-spike://app@evil/", "https://example.com/", "chat-spike://app:123/"]) {
    assert.equal(spikeResource(url), null, url);
  }
  assert.equal(isTrustedURL(`${SPIKE_ORIGIN}/#chat-1`, SPIKE_ORIGIN), true);
  assert.equal(isTrustedURL(`${SPIKE_ORIGIN}/spike.js`, SPIKE_ORIGIN), false);
});
