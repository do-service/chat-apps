import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/android.yml', import.meta.url), 'utf8');

// These are narrow publication-policy guards, not a general YAML parser.
function assertPolicy(text) {
  const events = text.split('\non:\n')[1]?.split('\npermissions:')[0];
  assert.ok(events?.startsWith('  workflow_dispatch:\n'), 'manual dispatch required');
  assert.doesNotMatch(events, /^  (push|pull_request|pull_request_target|schedule|repository_dispatch):/m);
  assert.match(text, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(text, /(?:contents|actions|id-token): write/);
  assert.match(text, /    if: github\.repository == 'do-service\/chat-apps' && github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\n/);
  assert.match(text, /    environment: android-debug-build\n/);
  assert.match(text, /    runs-on: ubuntu-24\.04\n/);
  assert.match(text, /node-version: "24\.19\.0"/);
  assert.match(text, /java-version: "21"/);
  assert.match(text, /sdkmanager --install "platforms;android-36" "build-tools;36\.0\.0"/);
  const actions = [...text.matchAll(/^\s+uses: (\S+)(?:\s+#.*)?$/gm)].map(match => match[1]);
  assert.equal(actions.length, 4);
  assert.ok(actions.every(action => /^actions\/(?:checkout|setup-node|setup-java|upload-artifact)@[0-9a-f]{40}$/.test(action)));
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /package-manager-cache: false/);
  assert.doesNotMatch(text, /actions\/cache@|cache: (?:npm|gradle)/);
  const steps = text.split(/^      - name: /m).slice(1);
  const secretSteps = steps.filter(step => step.includes('${{ secrets.'));
  assert.equal(secretSteps.length, 1, 'credentials must belong only to the export step');
  assert.ok(secretSteps[0].startsWith('Export only the approved GitLab frontend and mobile snapshot\n'));
  assert.deepEqual([...text.matchAll(/\$\{\{ secrets\.([A-Z_]+) \}\}/g)].map(match => match[1]).sort(), ['GITLAB_READ_TOKEN', 'GITLAB_READ_USERNAME']);
  for (const step of steps) {
    const run = step.split(/^        run: /m)[1];
    if (run) assert.doesNotMatch(run, /\$\{\{ (?:inputs|secrets)\./, 'never interpolate caller data or credentials into shell source');
  }
  assert.match(text, /node scripts\/android-source\.mjs "\$RUNNER_TEMP\/android-source"/);
  assert.match(text, /EXPECTED_SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(text, /Capacitor changed a reviewed native input/);
  assert.match(text, /testDebugUnitTest lintDebug assembleDebug/);
  assert.doesNotMatch(text, /assembleRelease|publishRelease|gh release|--publish always|git add -f/);
  const cleanup = steps.findIndex(step => step.startsWith('Remove the private build workspace'));
  const upload = steps.findIndex(step => step.startsWith('Upload only the verified test APK'));
  assert.ok(cleanup >= 0 && upload > cleanup);
  assert.match(steps[cleanup], /        if: always\(\)/);
  assert.match(steps[upload], /        if: success\(\)/);
  const paths = steps[upload].split('          path: |\n')[1]?.split('\n          if-no-files-found:')[0]?.trim().split('\n').map(line => line.trim());
  assert.deepEqual(paths, [
    '${{ runner.temp }}/android-artifacts/chat-mobile-preview-debug.apk',
    '${{ runner.temp }}/android-artifacts/SHA256SUMS.txt',
    '${{ runner.temp }}/android-artifacts/provenance.json',
  ]);
  assert.match(steps[upload], /if-no-files-found: error/);
  assert.match(steps[upload], /include-hidden-files: false/);
  assert.match(steps[upload], /retention-days: 3/);
}

test('Android workflow keeps manual trusted-main, pinned toolchain, and exact public artifact policy', () => assertPolicy(workflow));

for (const [name, before, after] of [
  ['push event', '  workflow_dispatch:', '  push:'],
  ['untrusted workflow ref', "github.ref == 'refs/heads/main'", "github.ref != ''"],
  ['missing protected environment', '    environment: android-debug-build\n', ''],
  ['write token', '  contents: read', '  contents: write'],
  ['moving action tag', 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803', 'actions/checkout@main'],
  ['persisted checkout credentials', 'persist-credentials: false', 'persist-credentials: true'],
  ['broad artifact upload', '${{ runner.temp }}/android-artifacts/chat-mobile-preview-debug.apk', '${{ runner.temp }}/**'],
  ['failure artifact publication', '        if: success()', '        if: always()'],
  ['release build', 'testDebugUnitTest lintDebug assembleDebug', 'testDebugUnitTest lintDebug assembleRelease'],
]) {
  test(`policy rejects ${name}`, () => {
    assert.ok(workflow.includes(before));
    assert.throws(() => assertPolicy(workflow.replace(before, after)));
  });
}

test('policy rejects a GitLab credential added to a later build step', () => {
  assert.throws(() => assertPolicy(workflow.replace('      - name: Install only the exported locked dependencies\n', '      - name: Install only the exported locked dependencies\n        env:\n          EXTRA: ${{ secrets.GITLAB_READ_TOKEN }}\n')));
});
