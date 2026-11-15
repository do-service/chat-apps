import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load, JSON_SCHEMA } from "js-yaml";

const desktop = await readFile(new URL("../.github/workflows/desktop.yml", import.meta.url), "utf8");

function desktopPolicy(text) {
  const doc = load(text, { schema: JSON_SCHEMA });
  assert.deepEqual(doc.permissions, { contents: "read" });
  assert.equal(doc.env?.DESKTOP_UPDATE_DISTRIBUTION, undefined);
  assert.deepEqual(Object.keys(doc.jobs), ["installers"]);
  const job = doc.jobs.installers;
  assert.equal(job.permissions, undefined);
  assert.equal(job.env.DESKTOP_UPDATE_DISTRIBUTION, undefined);
  assert.equal(job.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  const steps = job.steps.filter(step => step.env?.DESKTOP_UPDATE_DISTRIBUTION);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].run, "npm run build");
  assert.equal(steps[0].env.DESKTOP_UPDATE_DISTRIBUTION, "github-preview");
  const policy = job.steps.find(step => step.run?.includes("scripts/desktop-release-workflow.test.mjs"));
  assert.ok(policy, "desktop-only policy test must run without excluded Android inputs");
  assert.match(policy.run, /scripts\/artifacts\.test\.mjs scripts\/artifacts-preview\.test\.mjs/);
  assert.doesNotMatch(text, /release-workflows\.test\.mjs|android|SIGNING\.md/i);
  const artifacts = job.steps.find(step => step.id === "artifacts");
  assert.equal(artifacts.run, "node scripts/artifacts.mjs ${{ matrix.platform }} --preview");
  const packages = job.steps.filter(step => step.run?.includes("electron-builder/cli.js"));
  assert.equal(packages.length, 3);
  for (const step of packages) assert.match(step.run, /--publish never(?:\s|$)/);
  const mac = packages.find(step => step.id === "package_macos");
  assert.match(mac.run, /--mac dmg --arm64 --x64/);
  assert.match(mac.run, /-c\.mac\.identity=- -c\.mac\.hardenedRuntime=false -c\.mac\.notarize=false/);
  const uploads = job.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 1);
  const upload = uploads[0];
  assert.equal(upload.if, undefined);
  assert.equal(upload.with.path, "${{ steps.artifacts.outputs.paths }}");
  assert.equal(upload.with["include-hidden-files"], false);
  assert.equal(upload.with["if-no-files-found"], "error");
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^actions\/(?:checkout|setup-node|upload-artifact)@[0-9a-f]{40}$/);
    assert.equal(step.permissions, undefined);
  }
  const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.doesNotMatch(text, /verifyUpdateCodeSignature:\s*false|--mac zip|gh release|contents: write|id-token: write|pull_request_target:|secrets\./);
}

test("desktop distribution is build-scoped, read-only and uploads only verified preview artifacts", () => desktopPolicy(desktop));

for (const [name, before, after] of [
  ["write token", "contents: read", "contents: write"],
  ["job-wide distribution marker", 'CSC_IDENTITY_AUTO_DISCOVERY: "false"', 'CSC_IDENTITY_AUTO_DISCOVERY: "false"\n      DESKTOP_UPDATE_DISTRIBUTION: github-preview'],
  ["wrong distribution", "DESKTOP_UPDATE_DISTRIBUTION: github-preview", "DESKTOP_UPDATE_DISTRIBUTION: other"],
  ["Android-coupled policy import", "scripts/desktop-release-workflow.test.mjs", "scripts/release-workflows.test.mjs"],
  ["installer-only helper", "${{ matrix.platform }} --preview", "${{ matrix.platform }}"],
  ["automatic publication", "--win nsis --x64 --publish never", "--win nsis --x64 --publish always"],
  ["macOS ZIP updater", "--mac dmg --arm64 --x64", "--mac zip --arm64 --x64"],
  ["broad upload", "path: ${{ steps.artifacts.outputs.paths }}", "path: release/**"],
  ["hidden upload", "include-hidden-files: false", "include-hidden-files: true"],
  ["failure upload", "      - name: Upload test installers and checksums only", "      - if: always()\n        name: Upload test installers and checksums only"],
  ["persisted credentials", "persist-credentials: false", "persist-credentials: true"],
  ["unpinned action", "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "actions/checkout@main"],
]) test(`desktop policy rejects ${name}`, () => {
  assert.ok(desktop.includes(before), `missing mutation target: ${name}`);
  assert.throws(() => desktopPolicy(desktop.replace(before, after)));
});
