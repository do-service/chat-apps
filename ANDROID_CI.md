# Android debug APK — manual GitHub build

This pipeline builds a test APK on `ubuntu-24.04`; no Android SDK is installed on the developer's Mac. It does not publish a GitHub Release, Google Play package, source archive, backend, or Git history. Existing desktop workflows and installers are independent.

## Trusted inputs and access

- Workflow: [android.yml](<.github/workflows/android.yml>), manual `workflow_dispatch` only, repository `do-service/chat-apps`, branch `main` only.
- The `android-debug-build` GitHub Environment also restricts deployment branches to exactly `main`. Its Actions Secrets are `GITLAB_READ_USERNAME` and `GITLAB_READ_TOKEN`; only the source-export step receives them.
- The dedicated GitLab project deploy token has only `read_repository`, expires **2027-02-09 UTC**, and is not the existing administrative credential. Renew or revoke it through GitLab and update the Environment secrets; never send values in chat, commit them, or paste them into workflow inputs.
- GitLab `read_repository` is project-wide, not a path/commit-scoped permission. The trusted export helper enforces the narrower build-input policy. The token is not available to fork PR workflows or the desktop job.
- Supply a full 40-character source commit in `source_sha`. It must equal the current GitLab `main` tip; arbitrary branches and old history are not fetched for rebuilding. This is a deliberate first-preview restriction. Record the successful source/workflow SHAs from provenance.

## Source-export boundary

[android-source.mjs](<scripts/android-source.mjs>) uses stock Git with HTTPS verification, no redirects, isolated Git configuration, no checkout/archive hooks or credential persistence, and a temporary askpass program containing environment references only. Credentials are not put in URLs, command arguments, exported source, or public diagnostics.

The initial shallow `blob:none` fetch must contain exactly the requested commit, trees, and **zero blobs**. Git's silent unsupported-filter fallback is a failure even when Git exits successfully. The helper then selects only regular executable/non-executable files beneath `frontend/` and `mobile/`, fetches their explicit blob OIDs, verifies the exact final object inventory, and materializes their bytes without checkout filters or root attributes. Symlinks, submodules, traversal, oversized inputs and unsupported LFS pointers fail closed.

No backend, root project files or history enter the exported build input. Temporary Git metadata and askpass files are removed before the helper returns and before npm/build scripts run. If a server ignores filtering, objects could arrive in the temporary fetch area; the inventory gate blocks export/build/publication and cleanup removes that area. This is not a claim that an untrustworthy server cannot send unsolicited network bytes.

The job trusts the pinned CI helpers/actions, the approved private commit and its locked dependencies. A single hosted job is not a hard isolation boundary against malicious build dependencies or a compromised runner. Public workflow logs must not print source archives, credentials, configuration dumps or raw Git errors. An APK necessarily contains recoverable frontend JavaScript/assets; not mirroring raw source does not make the frontend confidential.

## Build and artifact gates

The job explicitly selects Node.js **24.19.0**, Java **21**, compile platform **37.0** (`platforms;android-37.0`) and verification Build Tools **36.0.0**, without dependency/source caches. The app retains **targetSdk 36 / minSdk 24**. Vasily separately approved the compile-only SDK increase after the first real AAR-metadata check showed that OkHttp **5.5.1** requires API 37. The library is not downgraded: its compromised-intermediate-certificate fix must remain available to AOSP devices. AGP **8.13.0** and Gradle **8.14.3** are unchanged, and their newer-SDK warning is not suppressed. SDK availability is checked before any optional install via the explicit SDK CLI path; no SDK is installed on the developer's Mac. The job:

1. Tests the trusted helpers before fetching private source.
2. Installs the exported frontend/mobile lockfiles and runs their tests/type checks.
3. Builds the local web bundle and generates Android Capacitor inputs.
4. Verifies that generation did not alter any reviewed native input file, and runs native source-policy checks.
5. Runs `testDebugUnitTest lintDebug assembleDebug` using the source Gradle wrapper.
6. Uses [android_artifact.py](<scripts/android_artifact.py>) with real SDK `apksigner` and `aapt`, bounded ZIP inspection and bundle/native-class checks.
7. Removes the private build workspace, then uploads exactly three files on success:
   - `chat-mobile-preview-debug.apk`
   - `SHA256SUMS.txt`
   - `provenance.json`

Artifact names include run ID/attempt; retention is **3 days**. No private source ZIP, Gradle logs, signing key, `.git` or whole workspace is uploaded. Provenance records hashes and tool/package information but is **unsigned metadata, not cryptographic build attestation**.

Public SDK runtime data is admitted only through the exact path/size/SHA-256 pins in [the verifier](<scripts/android_artifact.py>): the OkHttp Android 5.5.1 public-suffix database, two Firebase Messaging 26.0.1 event schemas, the transport-runtime 5.0.0 client-analytics schema, and the nested AndroidX annotation-jvm 1.10.0 license. The database and Messaging-schema bytes were observed in runner-built APKs and independently matched against official AAR/JAR resources. The license and client-analytics schema runner paths/sizes matched their official JAR/AAR; their bodies must still satisfy the independently verified official SHA-256 during APK verification. This is not a general allowance for assets, application source, `.proto` files, nested licenses or archives. A separate exact generated launcher-icon XML path is checked by size, file type and binary XML header; that is a format gate, not a content hash or full XML parser. Changed pinned bytes, aliases and directory metadata fail closed; other unknown entries remain rejected.

Local helper checks do not require npm installs or Android SDK; their SDK outputs are synthetic test fixtures:

```sh
node --test scripts/android-source.test.mjs scripts/android-workflow.test.mjs
python3 -B -m unittest discover -s scripts -p android_artifact_test.py
```

The workflow policy tests are narrow security/allowlist guards, not a general YAML parser. A real runner build is required for Android compilation and actual APK signature verification.

## Manual run and download

From an authenticated GitHub CLI with access to this repository:

```sh
gh workflow run android.yml --repo do-service/chat-apps --ref main \
  -f source_sha=7c9b6686f67a8b9c0bd179e8b405a18514a4d85c
```

If GitLab main moved, review its new commit and supply that full SHA instead. Download the successful run's `chat-android-debug-<run-id>-<attempt>` artifact from Actions and verify `SHA256SUMS.txt` before installing. Failed runs do not count as APK delivery; do not reuse an older artifact as evidence for a new source commit.

## Preview limitations

- A debug APK is automatically test-signed; no production signing credential or Google Play account is used. A fresh runner may generate a different debug certificate on the next build, so Android may reject an in-place update over an earlier test installation. A stable separate test key is a future, explicitly approved step; do not disable signature verification.
- This job deliberately has no Firebase configuration. FCM push remains unavailable; a successful build does not prove push delivery, IdP login, Keystore behavior, real WebView resources, or installed-device acceptance.
- Native microphone/camera capture and ordinary calls, P2P/relay, and arbitrary download/share/export remain unsupported in this source preview. Existing frontend gates must not be relaxed to obtain a green build.
- Neither this workflow nor this document authorizes a public Release, production signing, store publication, or a server deployment.
