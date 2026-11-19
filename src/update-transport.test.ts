import assert from "node:assert/strict";
import test from "node:test";
import { readPublicUpdateMetadata, type PublicUpdateFetch } from "./update-transport";
import { MAX_METADATA_BYTES, RELEASE_API } from "./update-release";
const asset = "https://github.com/do-service/chat-apps/releases/download/v0.1.1-preview.3/preview.yml";
const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/1/a?sig=fake";

test("public metadata transport follows only bounded GitHub redirects without cookies or auth", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const request: PublicUpdateFetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: cdn } }) : new Response("version: 0.1.1-preview.3");
  };
  assert.equal(await readPublicUpdateMetadata(asset, new AbortController().signal, request), "version: 0.1.1-preview.3");
  assert.deepEqual(calls.map((call) => call.url), [asset, cdn]);
  for (const { options } of calls) {
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual"); assert.equal(options.method, "GET");
    const headers = new Headers(options.headers); assert.equal(headers.has("cookie"), false); assert.equal(headers.has("authorization"), false);
  }
});

test("metadata transport rejects external redirects, loops, non-200, oversized declared or streamed data", async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: "https://evil.example/a" } }),
    () => new Response(null, { status: 302, headers: { location: asset } }),
    () => new Response(null, { status: 404 }),
    () => new Response("x", { headers: { "content-length": String(MAX_METADATA_BYTES + 1) } }),
    () => new Response("x".repeat(MAX_METADATA_BYTES + 1)),
    () => new Response(new Uint8Array([255])),
  ]) {
    let calls = 0;
    await assert.rejects(readPublicUpdateMetadata(asset, new AbortController().signal, async () => { calls++; return response(); }));
    assert.ok(calls <= 4);
  }
  let requested = false;
  await assert.rejects(readPublicUpdateMetadata("https://evil.example/a", new AbortController().signal, async () => { requested = true; return new Response("bad"); }));
  assert.equal(requested, false);
});

test("release API is fixed and an already cancelled request cannot consume metadata", async () => {
  const controller = new AbortController(); controller.abort();
  let requested = false;
  await assert.rejects(readPublicUpdateMetadata(RELEASE_API, controller.signal, async () => {
    requested = true; return new Response("[]");
  }), { name: "AbortError" });
  assert.equal(requested, false);
});
