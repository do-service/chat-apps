// Test-only Electron integration harness. Trust is pinned to the supplied
// loopback certificate in these disposable sessions, never in the application or OS.
const { app, session } = require("electron");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { randomBytes, randomUUID, X509Certificate } = require("node:crypto");
const https = require("node:https");
const path = require("node:path");

const release = path.resolve(__dirname, "../release");
app.setName("Chat D4 Cookie Smoke");
app.setPath("userData", path.join(release, "d4-cookie-profile"));
const { createElectronAuthAttempt, installAuthCookieBarrier } = require(path.join(release, "d4-auth-adapter.cjs"));
const { validateSessionCookie } = require(path.join(release, "d4-auth-service.cjs"));
const certificate = readFileSync(path.join(release, "d4-tls-cert.pem"));
const expectedFingerprint = new X509Certificate(certificate).fingerprint256;
const key = readFileSync(path.join(release, "d4-tls-key.pem"));
const cookieValue = randomBytes(32).toString("base64url");
const staleValue = randomBytes(32).toString("base64url");
const proof = { transaction_id: "A".repeat(43), code_verifier: "B".repeat(43) };
let origin = "";
let loggedOut = false;
let acknowledged = false;
let lateStarted;
const started = new Promise((resolve) => { lateStarted = resolve; });
let releaseLate;
const late = new Promise((resolve) => { releaseLate = resolve; });
function hasSession(request) { return (request.headers.cookie ?? "").split("; ").includes(`__Host-session=${cookieValue}`); }
function cookieHeader(value) {
  return `__Host-session=${value}; Path=/; Expires=${new Date(Date.now() + 3_600_000).toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}
const server = https.createServer({ key, cert: certificate }, async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/late") {
    lateStarted();
    await late;
    response.setHeader("Set-Cookie", cookieHeader(staleValue));
    response.writeHead(204).end();
    return;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (request.headers.origin !== origin || request.headers.authorization
      || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
    response.writeHead(403).end(); return;
  }
  if (request.url === "/auth/desktop/exchange" && request.method === "POST") {
    response.setHeader("Set-Cookie", cookieHeader(cookieValue));
    response.writeHead(204).end();
  } else if (request.url === "/api/me" && request.method === "GET" && hasSession(request) && !loggedOut) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "f3f6cf3d-e1db-416b-877c-fa967d84fd25" }));
  } else if (request.url === "/auth/desktop/ack" && request.method === "POST" && hasSession(request)) {
    acknowledged = true;
    response.writeHead(204).end();
  } else if (request.url === "/auth/logout" && request.method === "POST" && hasSession(request)) {
    loggedOut = true;
    response.setHeader("Set-Cookie", "__Host-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    response.writeHead(204).end();
  } else { response.writeHead(401).end(); }
});

function pin(jar) {
  jar.setCertificateVerifyProc((request, callback) => {
    try {
      const actual = new X509Certificate(request.certificate.data).fingerprint256;
      callback(request.hostname === "127.0.0.1" && actual === expectedFingerprint ? 0 : -2);
    } catch { callback(-2); }
  });
}

void app.whenReady().then(async () => {
  let result = 1;
  let target;
  let ephemeral;
  let port;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    origin = `https://127.0.0.1:${address.port}`;
    target = session.fromPartition(`d4-cookie-target-${randomUUID()}`, { cache: false });
    ephemeral = session.fromPartition(`d4-cookie-attempt-${randomUUID()}`, { cache: false });
    pin(target); pin(ephemeral);
    const barrier = installAuthCookieBarrier(target, () => null);
    port = createElectronAuthAttempt(origin, target, ephemeral);
    const staleResponse = target.fetch(`${origin}/late`, { credentials: "include" });
    await started;
    const releaseBarrier = barrier.begin();
    const exchange = await port.post("/auth/desktop/exchange", proof, AbortSignal.timeout(10_000));
    assert.equal(exchange.status, 204);
    const issued = await port.readCookies();
    assert.equal(issued.length, 1);
    assert.equal((await target.cookies.get({ url: origin, name: "__Host-session" })).length, 0);
    const cookie = validateSessionCookie(issued[0], origin, Date.now());
    await port.install(cookie);
    assert.equal(await port.verify(cookie), true);
    const ack = await port.post("/auth/desktop/ack", proof, AbortSignal.timeout(10_000));
    assert.equal(ack.status, 204);
    assert.equal(acknowledged, true);
    releaseBarrier();
    releaseLate();
    await staleResponse;
    const current = await target.cookies.get({ url: origin, name: "__Host-session" });
    assert.equal(current.length, 1);
    assert.equal(current[0].value === cookieValue, true, "unowned late Set-Cookie must not replace installed session");
    await port.logout();
    assert.equal(loggedOut, true);
    assert.equal((await port.readCookies()).length, 0);
    await port.rollback(cookie);
    assert.equal((await target.cookies.get({ url: origin, name: "__Host-session" })).length, 0);
    console.log("PASS: real Electron HTTPS fetch stores HttpOnly host cookie only in attempt jar");
    console.log("PASS: explicit install, authenticated /api/me, ACK cookie, late-cookie barrier, scoped logout/rollback");
    result = 0;
  } catch (error) {
    // Assertions contain test-only data; still avoid printing values/headers/URLs.
    console.error(`D4 cookie smoke failed: ${error instanceof Error ? error.name : "unknown"}`);
  } finally {
    releaseLate();
    try { await port?.dispose(); } catch { /* Test cleanup only. */ }
    for (const jar of [target, ephemeral]) {
      try { await jar?.closeAllConnections(); await jar?.clearStorageData(); } catch { /* Test cleanup only. */ }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.exit(result);
  }
}).catch(() => app.exit(1));
