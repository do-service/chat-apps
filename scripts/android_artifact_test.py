"""Synthetic ZIP and mocked SDK tests; these are NOT real APK/signature acceptance."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import sys
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile
import zlib

SPEC = importlib.util.spec_from_file_location("android_artifact", Path(__file__).with_name("android_artifact.py"))
artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifact)

CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' chat-resource: wss://chat.exz-vps.ru/livekit wss://chat.exz-vps.ru/livekit/ https://chat.exz-vps.ru/livekit https://chat.exz-vps.ru/livekit/; img-src 'self' data: blob: chat-resource: https:; media-src 'self' blob: chat-resource:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
BADGING = "package: name='ru.exzvps.chat.mobile.preview' versionCode='1' versionName='0.1.0-preview.1'\nsdkVersion:'24'\ntargetSdkVersion:'36'\napplication-label:'Chat'\napplication-debuggable\n"
CERT = "Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate DN: CN=Android Debug, O=Android, C=US\nSigner #1 certificate SHA-256 digest: " + "ab" * 32 + "\n"
CLASSES = ["Lru/exzvps/chat/mobile/preview/" + name + ";" for name in ["ChatMobilePlugin", "GuardedMessageHandler", "ChatRuntime"]]
SDK_PINS = {"assets/PublicSuffixDatabase.list": (132737, "c75ab827afd7ffff59a51b14729c25dbfc3b45237eb40ccf02bec7b7d44304a4"),
            "messaging_event.proto": (2381, "0b134a9ffe21416fe225f374f44f6eca58b47519feae4c90b82e25677e8d56ce"),
            "messaging_event_extension.proto": (883, "1b9c7669ea81fa9233cce0ca5e4b5f0478071c34fb40deea40d703c4565c42c6"),
            "META-INF/androidx/annotation/annotation/LICENSE.txt": (10175, "809fa1ed21450f59827d1e9aec720bbc4b687434fa22283c6cb5dd82a47ab9c0"),
            "client_analytics.proto": (2982, "0c76732776772b260528558f9b675a49529cad785c421ca11b487179b8162610"),
            "org/apache/cordova/allowlist/index.html": (2109, "5540004eb5fba60d58e9ecc4da04652841d4fac98c2a9ecae594ca5afccf080b")}


def dex_fixture(names=CLASSES):
    count = len(names)
    string_off = 112
    type_off = string_off + 4 * count
    class_off = type_off + 4 * count
    data_off = class_off + 32 * count
    data = bytearray(data_off)
    data[:8] = b"dex\n037\0"
    offsets = []
    for name in names:
        offsets.append(len(data))
        data.extend(bytes([len(name)]))
        data.extend(name.encode("ascii") + b"\0")
    for index in range(count):
        struct.pack_into("<I", data, string_off + index * 4, offsets[index])
        struct.pack_into("<I", data, type_off + index * 4, index)
        struct.pack_into("<8I", data, class_off + index * 32, index, 1, 0xFFFFFFFF, 0, 0xFFFFFFFF, 0, 0, 0)
    struct.pack_into("<3I", data, 32, len(data), 112, 0x12345678)
    struct.pack_into("<2I", data, 56, count, string_off)
    struct.pack_into("<2I", data, 64, count, type_off)
    struct.pack_into("<2I", data, 96, count, class_off)
    struct.pack_into("<2I", data, 104, len(data) - data_off, data_off)
    data[12:32] = hashlib.sha1(data[32:]).digest()
    struct.pack_into("<I", data, 8, zlib.adler32(data[12:]) & 0xFFFFFFFF)
    return bytes(data)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = Path(tempfile.mkdtemp(prefix="chat-android-artifact-test-")).resolve()
        self.addCleanup(self.clean_temporary)
        self.source = self.temporary / "source"
        self.www = self.source / "mobile/www"
        self.www.mkdir(parents=True)
        self.config = {"appId": "ru.exzvps.chat.mobile.preview", "appName": "Chat", "webDir": "www", "server": {"hostname": "localhost", "androidScheme": "https", "cleartext": False}, "plugins": {"CapacitorHttp": {"enabled": False}, "CapacitorCookies": {"enabled": False}}}
        self.write("mobile/package.json", json.dumps({"dependencies": {"@capacitor/core": "8.6.0"}, "devDependencies": {"@capacitor/android": "8.6.0", "@capacitor/cli": "8.6.0"}}))
        self.write("mobile/node_modules/@capacitor/android/package.json", '{"version":"8.6.0"}')
        self.write("mobile/node_modules/@capacitor/cli/package.json", '{"version":"8.6.0"}')
        self.write("mobile/node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js", "fixture SDK native bridge")
        self.write("mobile/android/app/src/main/assets/capacitor.config.json", json.dumps(self.config))
        self.write("mobile/android/app/src/main/assets/capacitor.plugins.json", "[]")
        self.write("mobile/www/index.html", '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + CSP + '"><script src="/mobile-bootstrap.js"></script><script type="module" src="/assets/app.js"></script></head></html>')
        self.write("mobile/www/mobile-bootstrap.js", "fixture classic bootstrap")
        self.write("mobile/www/mobile-native.css", "body { margin: 0; }")
        self.write("mobile/www/assets/app.js", "fixture bundled JavaScript")
        self.write("mobile/www/version.json", '{"version":"1794384881381"}')
        self.tools = self.temporary / "build-tools/36.0.0"
        self.tools.mkdir(parents=True)
        (self.tools / "source.properties").write_text("Pkg.Revision=36.0.0\n")
        for tool in ["aapt", "apksigner"]:
            (self.tools / tool).write_text("mocked SDK command, never executed\n")
            (self.tools / tool).chmod(0o700)
        self.apk = self.temporary / "app-debug.apk"
        self.output = self.temporary / "output"
        self.badging, self.cert, self.resources = BADGING, CERT, "fixture resources without provider configuration"
        self.mock_sdk = mock.patch.object(artifact, "run_sdk", side_effect=self.sdk)
        self.sdk_calls = self.mock_sdk.start()
        self.addCleanup(self.mock_sdk.stop)
        self.make_apk()

    def clean_temporary(self):
        root = self.temporary
        self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(root.name.startswith("chat-android-artifact-test-"))
        self.assertFalse(root.is_symlink())
        shutil.rmtree(root)

    def write(self, name, value):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def entries(self):
        entries = [("AndroidManifest.xml", b"fixture binary Android manifest"), ("resources.arsc", b"fixture resources"), ("classes.dex", dex_fixture())]
        entries.extend(("assets/public/" + path.relative_to(self.www).as_posix(), path.read_bytes()) for path in self.www.rglob("*") if path.is_file())
        entries.extend([("assets/native-bridge.js", b"fixture SDK native bridge"), ("assets/capacitor.config.json", json.dumps(self.config).encode()), ("assets/capacitor.plugins.json", b"[]")])
        return entries

    def make_apk(self, entries=None, compression=zipfile.ZIP_STORED):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.apk, "w", compression=compression) as archive:
                for name, value in self.entries() if entries is None else entries:
                    archive.writestr(name, value)

    def sdk(self, command, **kwargs):
        name = Path(command[0]).name
        if name == "apksigner" and command[1:] == ["version"]:
            return "0.9\n"
        if name == "aapt" and command[1:] == ["version"]:
            return "Android Asset Packaging Tool, v0.2-123456\n"
        if name == "apksigner" and command[1:4] == ["verify", "--verbose", "--print-certs"]:
            return self.cert
        if name == "aapt" and command[1:3] == ["dump", "badging"]:
            return self.badging
        if name == "aapt" and command[1:3] == ["dump", "resources"]:
            return self.resources
        raise AssertionError("unexpected SDK command shape")

    def prepare(self, **kwargs):
        options = dict(source=self.source, apk=self.apk, output=self.output, source_commit="a" * 40, workflow_commit="b" * 40, build_tools=self.tools)
        options.update(kwargs)
        return artifact.prepare(**options)

    def rejected(self):
        with self.assertRaises(artifact.VerificationError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_exact_three_outputs_unsigned_provenance_and_apk_identity(self):
        provenance = self.prepare()
        self.assertEqual({p.name for p in self.output.iterdir()}, {"chat-mobile-preview-debug.apk", "SHA256SUMS.txt", "provenance.json"})
        self.assertEqual((self.output / "chat-mobile-preview-debug.apk").read_bytes(), self.apk.read_bytes())
        encoded = (self.output / "provenance.json").read_text()
        self.assertNotIn(str(self.source), encoded)
        self.assertNotIn("files_inventory", encoded)
        self.assertFalse(provenance["provenance_signed"])
        self.assertEqual(provenance["source_commit"], "a" * 40)
        self.assertEqual(provenance["workflow_commit"], "b" * 40)
        self.assertEqual(provenance["signing"]["certificate_sha256"], "ab" * 32)
        self.assertEqual(provenance["package"]["version_name"], "0.1.0-preview.1")
        lines = (self.output / "SHA256SUMS.txt").read_text().splitlines()
        self.assertEqual(len(lines), 2)
        for line in lines:
            digest, name = line.split("  ")
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(self.sdk_calls.call_count, 5)

    def test_only_empty_source_verified_capacitor_cordova_extras_allowed(self):
        entries = self.entries() + [("assets/public/cordova.js", b""), ("assets/public/cordova_plugins.js", b"")]
        self.make_apk(entries)
        self.prepare()

    def test_fixed_phase_diagnostics_keep_exact_stdout_contract(self):
        args = ["--source", str(self.source), "--apk", str(self.apk), "--output", str(self.output), "--source-commit", "a" * 40, "--workflow-commit", "b" * 40, "--build-tools", str(self.tools)]
        with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(artifact.main(args), 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"files": sorted(artifact.OUTPUT_NAMES)})
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", "android-artifact: phase=apk-inspection-ok", "android-artifact: phase=sdk-verification-ok"])

    def test_generated_icon_resource_is_one_exact_path_and_size(self):
        name = "res/drawable-v24/$ic_launcher_foreground__0.xml"
        self.assertEqual(getattr(artifact, "COMPILED_ICON_XML_PATH", None), name)
        self.assertEqual(getattr(artifact, "COMPILED_ICON_XML_SIZE", None), 788)
        self.assertEqual(hashlib.sha256(name.encode()).hexdigest(), "2801305dfc7ac0e5b6be3fe3447fb61b42f1aa0094d636922dde241816b0740d")

    def test_exact_generated_icon_binary_header_fixture_is_accepted(self):
        name = "res/drawable-v24/$ic_launcher_foreground__0.xml"
        data = struct.pack("<HHI", 3, 8, 788) + bytes(780)
        for kind in [0, stat.S_IFREG]:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (kind | 0o644) << 16
            self.make_apk(self.entries() + [(info, data)])
            output = self.temporary / ("icon-" + str(kind))
            self.prepare(output=output)
            self.assertEqual((output / "chat-mobile-preview-debug.apk").read_bytes(), self.apk.read_bytes())
        self.assertEqual(self.sdk_calls.call_count, 10)

    def test_generated_icon_wrong_size_raw_xml_or_top_header_rejected(self):
        name = "res/drawable-v24/$ic_launcher_foreground__0.xml"
        invalid = [struct.pack("<HHI", 3, 8, 787) + bytes(779), struct.pack("<HHI", 3, 8, 789) + bytes(781), b"<vector/>".ljust(788, b" "), struct.pack("<HHI", 2, 8, 788) + bytes(780), struct.pack("<HHI", 3, 12, 788) + bytes(780), struct.pack("<HHI", 3, 8, 787) + bytes(780)]
        for data in invalid:
            self.make_apk(self.entries() + [(name, data)])
            self.rejected()
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_generated_icon_aliases_and_directory_flags_rejected(self):
        name = "res/drawable-v24/$ic_launcher_foreground__0.xml"
        data = struct.pack("<HHI", 3, 8, 788) + bytes(780)
        for alias in [name.replace("__0", "__1"), name.replace("ic_launcher", "IC_launcher"), name.replace("drawable-v24", "drawable-v23"), "assets/" + name, name + ".gz", name + "/", "res/drawable-v24/$CustomerValue.xml"]:
            self.make_apk(self.entries() + [(alias, b"" if alias.endswith("/") else data)])
            self.rejected()
        for attrs in [(stat.S_IFDIR | 0o755) << 16, ((stat.S_IFREG | 0o644) << 16) | 0x10]:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = attrs
            self.make_apk(self.entries() + [(info, data)])
            self.rejected()
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_production_sdk_pins_are_exactly_six_pinned_vendor_resources(self):
        self.assertEqual(artifact.VERIFIED_SDK_MEMBERS, SDK_PINS)

    def test_exact_sdk_resource_stream_hash_with_synthetic_expected_tuple(self):
        resources = [(name, b"synthetic SDK data; not real APK acceptance: " + name.encode()) for name in SDK_PINS]
        expected = {name: (len(data), hashlib.sha256(data).hexdigest()) for name, data in resources}
        self.make_apk(self.entries() + resources)
        with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", expected):
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.prepare()
        self.assertEqual(self.sdk_calls.call_count, 5)
        self.assertNotIn("rejected-sdk-candidate", stderr.getvalue())
        self.assertEqual((self.output / "chat-mobile-preview-debug.apk").read_bytes(), self.apk.read_bytes())

    def test_verified_protos_never_log_rejected_for_other_unexpected_member(self):
        resources = [(name, b"FakeSecretSyntheticSdkData: " + name.encode()) for name in SDK_PINS]
        expected = {name: (len(data), hashlib.sha256(data).hexdigest()) for name, data in resources}
        self.make_apk(self.entries() + [("assets/UnknownCustomerValue.bin", b"FakeSecretUnknown")] + resources)
        with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", expected), contextlib.redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaisesRegex(artifact.VerificationError, "^unexpected APK member$"):
                self.prepare()
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", "android-artifact: rejected-member namespace=assets path-sha256=" + hashlib.sha256(b"assets/UnknownCustomerValue.bin").hexdigest() + " bytes=17 shape=other"])
        self.assertFalse(self.output.exists())
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_pinned_sdk_unix_directory_mode_without_slash_rejected(self):
        data = b"synthetic SDK bytes"
        for name in SDK_PINS:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFDIR | 0o755) << 16
            self.make_apk(self.entries() + [(info, data)])
            with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {name: (len(data), hashlib.sha256(data).hexdigest())}):
                self.rejected()
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_pinned_sdk_regular_mode_with_dos_directory_bit_rejected(self):
        data = b"synthetic SDK bytes"
        for name in SDK_PINS:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = ((stat.S_IFREG | 0o644) << 16) | 0x10
            self.make_apk(self.entries() + [(info, data)])
            with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {name: (len(data), hashlib.sha256(data).hexdigest())}):
                self.rejected()
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_pinned_sdk_zero_or_regular_unix_type_flags_still_accepted(self):
        data = b"synthetic SDK bytes"
        for index, name in enumerate(SDK_PINS):
            for kind in [0, stat.S_IFREG]:
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (kind | 0o644) << 16
                self.make_apk(self.entries() + [(info, data)])
                output = self.temporary / ("mode-" + str(index) + "-" + str(kind))
                with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {name: (len(data), hashlib.sha256(data).hexdigest())}):
                    self.prepare(output=output)
                self.assertEqual((output / "chat-mobile-preview-debug.apk").read_bytes(), self.apk.read_bytes())
        self.assertEqual(self.sdk_calls.call_count, 60)

    def test_sdk_resource_mutations_lengths_case_paths_and_archive_aliases_rejected(self):
        for name, (size, _) in SDK_PINS.items():
            for data in [b"x" * size, b"x" * (size - 1)]:
                self.make_apk(self.entries() + [(name, data)])
                with contextlib.redirect_stderr(io.StringIO()) as stderr:
                    self.rejected()
                self.assertNotIn("rejected-sdk-candidate", stderr.getvalue())
            data = b"synthetic SDK bytes"
            with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {name: (len(data) + 1, hashlib.sha256(data).hexdigest())}):
                self.make_apk(self.entries() + [(name, data)])
                self.rejected()
            for alias in [name.swapcase(), "assets/" + name, name + ".gz", name + ".extra", "assets/public/" + name, name + "/"]:
                self.make_apk(self.entries() + [(alias, b"" if alias.endswith("/") else data)])
                self.rejected()
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_first_unexpected_entry_diagnoses_all_unapproved_protos_not_verified_db(self):
        name, data = "assets/PublicSuffixDatabase.list", b"synthetic verified SDK data"
        protos = [("messaging_event.proto", b"FakeSecretOne"), ("messaging_event_extension.proto", b"FakeSecretTwo")]
        self.make_apk(self.entries() + [(name, data), ("assets/UnknownCustomerValue.bin", b"FakeSecretUnknown")] + protos)
        with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {name: (len(data), hashlib.sha256(data).hexdigest())}, create=True), contextlib.redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaisesRegex(artifact.VerificationError, "^unexpected APK member$"):
                self.prepare()
        expected = ["android-artifact: phase=source-bundle-ok", "android-artifact: rejected-member namespace=assets path-sha256=" + hashlib.sha256(b"assets/UnknownCustomerValue.bin").hexdigest() + " bytes=17 shape=other"]
        for path, payload in protos:
            identifier = "firebase-messaging-event-proto" if path == "messaging_event.proto" else "firebase-messaging-event-extension-proto"
            expected.append(f"android-artifact: rejected-sdk-candidate id={identifier} bytes={len(payload)} sha256={hashlib.sha256(payload).hexdigest()}")
        self.assertEqual(stderr.getvalue().splitlines(), expected)
        self.assertNotIn("FakeSecret", stderr.getvalue())
        self.assertNotIn("okhttp-public-suffix-db", stderr.getvalue())
        self.assertNotIn("UnknownCustomerValue", stderr.getvalue())
        self.assertFalse(self.output.exists())
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_known_sdk_diagnostics_do_not_allow_candidates_or_leak_content(self):
        candidates = {"messaging_event.proto": "firebase-messaging-event-proto", "messaging_event_extension.proto": "firebase-messaging-event-extension-proto"}
        payload = b"FakeSecretContent-not-for-public-logs"
        for name, identifier in candidates.items():
            self.make_apk(self.entries() + [(name, payload)])
            with self.subTest(name=name), mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {"assets/PublicSuffixDatabase.list": SDK_PINS["assets/PublicSuffixDatabase.list"]}), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
                with self.assertRaisesRegex(artifact.VerificationError, "^unexpected APK member$"):
                    self.prepare()
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", f"android-artifact: rejected-member namespace=root path-sha256={hashlib.sha256(name.encode()).hexdigest()} bytes={len(payload)} shape=other", f"android-artifact: rejected-sdk-candidate id={identifier} bytes={len(payload)} sha256={hashlib.sha256(payload).hexdigest()}"])
            self.assertNotIn("FakeSecret", stderr.getvalue())
            self.assertNotIn(str(self.source), stderr.getvalue())
            self.assertFalse(artifact.package_member(name))
            self.assertFalse(self.output.exists())
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_known_candidate_diagnostic_is_bounded_and_bad_zip_is_redacted(self):
        name = "messaging_event.proto"
        self.make_apk(self.entries() + [(name, b"x" * (1024 * 1024 + 1))])
        with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {"assets/PublicSuffixDatabase.list": SDK_PINS["assets/PublicSuffixDatabase.list"]}), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.rejected()
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", f"android-artifact: rejected-member namespace=root path-sha256={hashlib.sha256(name.encode()).hexdigest()} bytes={1024 * 1024 + 1} shape=other", "android-artifact: rejected-sdk-candidate id=firebase-messaging-event-proto metadata=over-limit"])
        self.make_apk(self.entries() + [(name, b"FakeSecretCrcPayload")])
        self.apk.write_bytes(self.apk.read_bytes().replace(b"FakeSecretCrcPayload", b"FakeSecretCrcTamper!"))
        with mock.patch.object(artifact, "VERIFIED_SDK_MEMBERS", {"assets/PublicSuffixDatabase.list": SDK_PINS["assets/PublicSuffixDatabase.list"]}), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.rejected()
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", f"android-artifact: rejected-member namespace=root path-sha256={hashlib.sha256(name.encode()).hexdigest()} bytes={len(b'FakeSecretCrcPayload')} shape=other", "android-artifact: rejected-sdk-candidate id=firebase-messaging-event-proto metadata=unavailable"])
        self.assertNotIn("FakeSecret", stderr.getvalue())
        self.assertNotIn(name, stderr.getvalue())

    def test_error_reason_is_only_sha256_and_os_errors_remain_generic(self):
        args = ["--source", str(self.source), "--apk", str(self.apk), "--output", str(self.output), "--source-commit", "a" * 40, "--workflow-commit", "b" * 40, "--build-tools", str(self.tools)]
        reason = "FakeSecretReason " + str(self.source) + " raw SDK stdout"
        with mock.patch.object(artifact, "source_bundle", side_effect=artifact.VerificationError(reason)), contextlib.redirect_stderr(io.StringIO()) as stderr, contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(artifact.main(args), 1)
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: reason-sha256=" + hashlib.sha256(reason.encode()).hexdigest(), "android-artifact: verification failed; no public artifact was accepted"])
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("FakeSecret", stderr.getvalue())
        self.assertNotIn(str(self.source), stderr.getvalue())
        with mock.patch.object(artifact, "source_bundle", side_effect=OSError(reason)), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(artifact.main(args), 1)
        self.assertEqual(stderr.getvalue(), "android-artifact: verification failed; no public artifact was accepted\n")
        self.assertFalse(self.output.exists())
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_unknown_member_only_emits_static_namespace_shape_path_hash_and_size(self):
        paths = [("CustomerValue.bin", "root", "other"), ("assets/CustomerValue.bin", "assets", "other"), ("res/drawable/$CustomerValue.xml", "res", "generated-xml"), ("META-INF/CustomerValue.bin", "META-INF", "other"), ("kotlin/CustomerValue.bin", "kotlin", "other"), ("lib/x86_64/CustomerValue.bin", "lib", "other"), ("CustomerOrg/CustomerValue.bin", "other", "other")]
        payload = b"FakeSecretBody"
        for name, namespace, shape in paths:
            self.make_apk(self.entries() + [(name, payload)])
            with self.subTest(name=name), contextlib.redirect_stderr(io.StringIO()) as stderr:
                with self.assertRaisesRegex(artifact.VerificationError, "^unexpected APK member$"):
                    self.prepare()
            self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", f"android-artifact: rejected-member namespace={namespace} path-sha256={hashlib.sha256(name.encode()).hexdigest()} bytes={len(payload)} shape={shape}"])
            self.assertNotIn("CustomerValue", stderr.getvalue())
            self.assertNotIn("FakeSecret", stderr.getvalue())
            self.assertFalse(self.output.exists())
        self.assertEqual(self.sdk_calls.call_count, 0)

    def test_bad_zip_reason_fingerprint_never_contains_raw_bytes_or_path(self):
        args = ["--source", str(self.source), "--apk", str(self.apk), "--output", str(self.output), "--source-commit", "a" * 40, "--workflow-commit", "b" * 40, "--build-tools", str(self.tools)]
        self.apk.write_bytes(b"FakeSecretInvalidZipBody")
        with contextlib.redirect_stderr(io.StringIO()) as stderr, contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(artifact.main(args), 1)
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", "android-artifact: reason-sha256=" + hashlib.sha256(b"APK artifact verification failed").hexdigest(), "android-artifact: verification failed; no public artifact was accepted"])
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("FakeSecret", stderr.getvalue())
        self.assertNotIn(str(self.source), stderr.getvalue())
        self.assertFalse(self.output.exists())

    def test_failure_diagnostics_never_emit_unknown_names_paths_or_sdk_output(self):
        args = ["--source", str(self.source), "--apk", str(self.apk), "--output", str(self.output), "--source-commit", "a" * 40, "--workflow-commit", "b" * 40, "--build-tools", str(self.tools)]
        for name in ["assets/CustomerTokenValue123.bin", "assets/FakeSecret.json"]:
            self.make_apk(self.entries() + [(name, b"FakeSecretContent")])
            with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(artifact.main(args), 1)
            self.assertEqual(stdout.getvalue(), "")
            expected = ["android-artifact: phase=source-bundle-ok"]
            reason = "unexpected APK member" if name == "assets/CustomerTokenValue123.bin" else "credential configuration rejected"
            if reason == "unexpected APK member":
                expected.append(f"android-artifact: rejected-member namespace=assets path-sha256={hashlib.sha256(name.encode()).hexdigest()} bytes={len(b'FakeSecretContent')} shape=other")
            expected.extend(["android-artifact: reason-sha256=" + hashlib.sha256(reason.encode()).hexdigest(), "android-artifact: verification failed; no public artifact was accepted"])
            self.assertEqual(stderr.getvalue().splitlines(), expected)
            self.assertNotIn(name, stderr.getvalue())
            self.assertNotIn(str(self.source), stderr.getvalue())
            self.assertFalse(self.output.exists())
        self.make_apk()
        self.sdk_calls.side_effect = artifact.VerificationError("FakeSecretSdkStdout " + str(self.source))
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(artifact.main(args), 1)
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: phase=source-bundle-ok", "android-artifact: phase=apk-inspection-ok", "android-artifact: reason-sha256=" + hashlib.sha256(("FakeSecretSdkStdout " + str(self.source)).encode()).hexdigest(), "android-artifact: verification failed; no public artifact was accepted"])
        with mock.patch.object(artifact, "source_bundle", side_effect=artifact.VerificationError("FakeSecretSource " + str(self.source))), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(artifact.main(args), 1)
        self.assertEqual(stderr.getvalue().splitlines(), ["android-artifact: reason-sha256=" + hashlib.sha256(("FakeSecretSource " + str(self.source)).encode()).hexdigest(), "android-artifact: verification failed; no public artifact was accepted"])

    def test_nonempty_or_arbitrary_generated_extras_rejected(self):
        for name, payload in [("assets/public/cordova.js", b"evil"), ("assets/public/plugins/a.js", b""), ("assets/extra.txt", b"leak")]:
            with self.subTest(name=name):
                self.make_apk(self.entries() + [(name, payload)])
                self.rejected()

    def test_wrong_package_version_sdk_or_not_debuggable_rejected(self):
        for bad in [BADGING.replace("mobile.preview", "mobile.release"), BADGING.replace("0.1.0-preview.1", "1.0"), BADGING.replace("versionCode='1'", "versionCode='2'"), BADGING.replace("sdkVersion:'24'", "sdkVersion:'23'"), BADGING.replace("targetSdkVersion:'36'", "targetSdkVersion:'35'"), BADGING.replace("application-debuggable", "application-not-debuggable")]:
            with self.subTest(bad=bad):
                self.badging = bad
                self.rejected()

    def test_release_subject_multiple_signers_and_missing_verification_rejected(self):
        for bad in [CERT.replace("Android Debug", "Release"), CERT.replace("Number of signers: 1", "Number of signers: 2"), CERT.replace("Verifies\n", ""), CERT.replace("v2): true", "v2): false"), CERT.replace("ab" * 32, "not-a-digest")]:
            with self.subTest(bad=bad):
                self.cert = bad
                self.rejected()

    def test_native_config_bridge_or_installed_sdk_mismatch_rejected(self):
        original = self.entries()
        for changed in [[(name, b"tampered bridge" if name == "assets/native-bridge.js" else data) for name, data in original], [(name, b"[]" if name == "assets/capacitor.config.json" else data) for name, data in original], [(name, b'["unexpected-plugin"]' if name == "assets/capacitor.plugins.json" else data) for name, data in original]]:
            self.make_apk(changed)
            self.rejected()
        self.make_apk()
        self.write("mobile/node_modules/@capacitor/android/package.json", '{"version":"8.5.0"}')
        self.rejected()

    def test_sdk_runtime_metadata_and_multidex_allowed_without_raw_source(self):
        entries = [(name, dex_fixture(CLASSES[:1]) if name == "classes.dex" else data) for name, data in self.entries()]
        entries += [("classes2.dex", dex_fixture(CLASSES[1:])), ("firebase-messaging.properties", b"version=26.0.1\nclient=firebase-messaging\n"), ("META-INF/androidx.core_core.version", b"1.17.0"), ("kotlin/kotlin.kotlin_builtins", b"compiled metadata"), ("lib/arm64-v8a/libfixture.so", b"compiled library"), ("res/drawable/icon.xml", b"binary XML fixture"), ("META-INF/", b"")]
        self.make_apk(entries)
        self.prepare()

    def test_partial_output_cleanup_and_cli_failures_do_not_publish(self):
        with mock.patch.object(artifact.shutil, "copyfileobj", side_effect=OSError("synthetic failure")):
            self.rejected()
        with mock.patch.object(artifact.json, "dumps", side_effect=ValueError("synthetic failure")):
            self.rejected()
        args = ["--source", str(self.source), "--apk", str(self.apk), "--output", str(self.output), "--source-commit", "invalid", "--workflow-commit", "b" * 40, "--build-tools", str(self.tools)]
        with contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(artifact.main(args), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn(str(self.source), stderr.getvalue())
        self.assertFalse(self.output.exists())

    def test_zip_comments_nul_paths_and_unsupported_encoding_rejected(self):
        with zipfile.ZipFile(self.apk, "a") as archive:
            archive.comment = b"unexpected archive payload"
        self.rejected()
        self.make_apk(self.entries() + [("assets/public/badXname.js", b"fixture")])
        self.apk.write_bytes(self.apk.read_bytes().replace(b"badXname.js", b"bad\0name.js"))
        self.rejected()
        self.make_apk(compression=zipfile.ZIP_BZIP2)
        self.rejected()

    def test_sdk_child_failure_and_invalid_versions_fail_closed(self):
        self.sdk_calls.side_effect = artifact.VerificationError("SDK command failed")
        self.rejected()
        self.sdk_calls.side_effect = self.sdk
        (self.tools / "source.properties").write_text("Pkg.Revision=35.0.0\n")
        self.rejected()

    def test_firebase_configuration_raw_or_compiled_rejected(self):
        self.resources = "spec resource 0x7f010000 ru.exzvps.chat.mobile.preview:string/google_app_id: flags=0x0"
        self.rejected()
        self.resources = "safe resources"
        self.make_apk(self.entries() + [("assets/google-services.json", b"not real credentials")])
        self.rejected()
        self.make_apk()
        self.write("mobile/android/app/google-services.json", "fixture not real configuration")
        self.rejected()

    def test_duplicate_noncanonical_symlink_and_private_entries_rejected(self):
        names = ["../outside", "/outside", "res//a.xml", "res/./a.xml", "assets\\public\\x", "assets/public/%2e%2e/x", "backend/config.go", ".git/config", "assets/private.pem", "src/MainActivity.java", "secrets.properties", "META-INF/service-account.json"]
        for name in names:
            with self.subTest(name=name):
                self.make_apk(self.entries() + [(name, b"fixture")])
                self.rejected()
        self.make_apk(self.entries() + [("classes.dex", dex_fixture())])
        self.rejected()
        info = zipfile.ZipInfo("assets/public/link.js")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.make_apk(self.entries() + [(info, b"elsewhere")])
        self.rejected()

    def test_changed_missing_asset_or_missing_real_class_definition_rejected(self):
        for entries in [[(name, b"changed" if name == "assets/public/mobile-bootstrap.js" else data) for name, data in self.entries()], [(name, data) for name, data in self.entries() if name != "assets/public/index.html"], [(name, dex_fixture(CLASSES[:2])) if name == "classes.dex" else (name, data) for name, data in self.entries()]]:
            self.make_apk(entries)
            self.rejected()
        fake = dex_fixture(CLASSES[:2]) + CLASSES[2].encode()
        self.make_apk([(name, fake) if name == "classes.dex" else (name, data) for name, data in self.entries()])
        self.rejected()

    def test_inert_or_outside_head_csp_and_bootstrap_rejected(self):
        csp = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'
        boot = '<script src="/mobile-bootstrap.js"></script>'
        module = '<script type="module" src="/assets/app.js"></script>'
        invalid = [
            '<html><head></head><body>' + csp + boot + module + '</body></html>',
            '<html><head>' + csp + '<template>' + boot + '</template>' + module + '</head></html>',
            '<html><head><template>' + csp + '</template>' + boot + module + '</head></html>',
            '<html><head>' + csp + '<noscript>' + boot + '</noscript>' + module + '</head></html>',
            '<html><head><noscript>' + csp + '</noscript>' + boot + module + '</head></html>',
            '<html><head>' + csp + '<title>' + boot + '</title>' + module + '</head></html>',
            '<html><head>' + csp + '<svg>' + boot + '</svg>' + module + '</head></html>',
            '<html><head><div></div>' + csp + boot + module + '</head></html>',
            '<html><head>implicit head close' + csp + boot + module + '</head></html>',
            '<html><head>' + csp + boot + module + '</html>',
        ]
        for html in invalid:
            with self.subTest(html=html[:100]), self.assertRaises(artifact.VerificationError):
                parser = artifact.BundleHTML()
                parser.feed(html)
                parser.close()
                parser.validate()

    def test_nonexecutable_bootstrap_and_duplicate_critical_attributes_rejected(self):
        index = (self.www / "index.html").read_text()
        boot = '<script src="/mobile-bootstrap.js"></script>'
        invalid = [index.replace(boot, '<script nomodule src="/mobile-bootstrap.js"></script>'),
                   index.replace(boot, '<script type="text/plain" src="/mobile-bootstrap.js"></script>'),
                   index.replace(boot, '<script defer src="/mobile-bootstrap.js"></script>'),
                   index.replace(boot, '<script src="/assets/evil.js" src="/mobile-bootstrap.js"></script>'),
                   index.replace('content="' + CSP + '"', 'content="script-src *" content="' + CSP + '"')]
        for html in invalid:
            with self.subTest(html=html[:100]), self.assertRaises(artifact.VerificationError):
                parser = artifact.BundleHTML()
                parser.feed(html)
                parser.close()
                parser.validate()

    def test_html_non_ascii_whitespace_cannot_implicitly_close_head(self):
        index = (self.www / "index.html").read_text()
        for text in ["\u00a0", "\u2003", "&nbsp;", "\u000b"]:
            for marker in ["<head>", '<script src="/mobile-bootstrap.js">', '<script type="module"']:
                html = index.replace(marker, marker + text if marker == "<head>" else text + marker)
                with self.subTest(text=repr(text), marker=marker), self.assertRaises(artifact.VerificationError):
                    parser = artifact.BundleHTML()
                    parser.feed(html)
                    parser.close()
                    parser.validate()

    def test_html_ascii_whitespace_keeps_csp_and_bootstrap_active(self):
        index = (self.www / "index.html").read_text()
        for text in [" ", "\t", "\n", "\r", "\f", " \t\n\r\f"]:
            html = index.replace("<head>", "<head>" + text).replace('<script src="/mobile-bootstrap.js">', text + '<script src="/mobile-bootstrap.js">')
            with self.subTest(text=repr(text)):
                parser = artifact.BundleHTML()
                parser.feed(html)
                parser.close()
                parser.validate()

    def test_known_generated_head_with_title_style_voids_and_body_stays_valid(self):
        html = (self.www / "index.html").read_text().replace('<script type="module"', '<meta charset="UTF-8"/><link rel="manifest" href="/manifest.webmanifest"/><title>Chat</title><style>html,body{background:#111}</style><script type="module"')
        html = html.replace('</html>', '<body><div id="root"><div class="boot-loader"></div></div></body></html>')
        parser = artifact.BundleHTML()
        parser.feed(html)
        parser.close()
        parser.validate()

    def test_source_csp_bootstrap_order_symlink_and_raw_source_rejected(self):
        index = (self.www / "index.html").read_text()
        for changed in [index.replace("script-src 'self'", "script-src *"), index.replace('<script src="/mobile-bootstrap.js"></script>', '<script type="module" src="/mobile-bootstrap.js"></script>'), index.replace('<script src="/mobile-bootstrap.js"></script>', '<script async src="/mobile-bootstrap.js"></script>'), index.replace('<script src="/mobile-bootstrap.js"></script>', '<script src="/mobile-bootstrap.js"/>')]:
            self.write("mobile/www/index.html", changed)
            self.make_apk()
            self.rejected()
        self.write("mobile/www/index.html", index)
        self.write("mobile/www/source.ts", "fixture raw source")
        self.make_apk()
        self.rejected()

    def test_malformed_package_reserved_www_and_source_symlinks_rejected(self):
        for value in ["[]", '{"dependencies":[]}', '{"dependencies":{},"dependencies":{}}']:
            self.write("mobile/package.json", value)
            self.rejected()
        self.write("mobile/package.json", json.dumps({"dependencies": {"@capacitor/core": "8.6.0"}, "devDependencies": {"@capacitor/android": "8.6.0", "@capacitor/cli": "8.6.0"}}))
        outside = self.temporary / "outside-fixture.js"
        outside.write_text("not source bundle")
        (self.www / "linked.js").symlink_to(outside)
        self.rejected()
        # Only this known synthetic link is removed; never follow it to the target.
        self.assertEqual((self.www / "linked.js").resolve(), outside)
        (self.www / "linked.js").unlink()
        self.write("mobile/www/cordova.js", "unexpected original SDK override")
        self.make_apk()
        self.rejected()

    def test_case_collisions_directory_collisions_and_corrupt_dex_rejected(self):
        for entries in [self.entries() + [("CLASSES.DEX", dex_fixture())], self.entries() + [("assets/public", b"collision")], [(name, b"dex\\n037\\0" + b"0" * 120) if name == "classes.dex" else (name, data) for name, data in self.entries()]]:
            self.make_apk(entries)
            self.rejected()

    def test_source_archive_cannot_hide_inside_matching_www(self):
        self.write("mobile/www/assets/source.zip", "synthetic private source archive")
        self.make_apk()
        self.rejected()

    def test_oversized_apk_member_total_and_compression_bomb_rejected(self):
        with mock.patch.object(artifact, "MAX_APK", 10):
            self.rejected()
        with mock.patch.object(artifact, "MAX_MEMBER", 10):
            self.rejected()
        with mock.patch.object(artifact, "MAX_TOTAL", 10):
            self.rejected()
        self.make_apk(self.entries() + [("res/raw/bomb.xml", b"0" * 1000000)], compression=zipfile.ZIP_DEFLATED)
        self.rejected()

    def test_existing_output_and_symlink_inputs_rejected_without_clobber(self):
        self.output.mkdir()
        (self.output / "keep").write_text("untouched")
        with self.assertRaises(artifact.VerificationError): self.prepare()
        self.assertEqual((self.output / "keep").read_text(), "untouched")
        linked = self.temporary / "linked.apk"
        linked.symlink_to(self.apk)
        with self.assertRaises(artifact.VerificationError): self.prepare(apk=linked, output=self.temporary / "other")
        linked_source = self.temporary / "linked-source"
        linked_source.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(artifact.VerificationError): self.prepare(source=linked_source, output=self.temporary / "other")

    def test_sha_validation_and_cli_exact_arguments(self):
        for bad in ["a" * 39, "g" * 40, "a" * 40 + "\n"]:
            with self.assertRaises(artifact.VerificationError): self.prepare(source_commit=bad)
        args = ["--source", str(self.source), "--apk", str(self.apk), "--output", str(self.output), "--source-commit", "a" * 40, "--workflow-commit", "b" * 40, "--build-tools", str(self.tools)]
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(artifact.main(args), 0)
        self.assertEqual(set(json.loads(stdout.getvalue())["files"]), {"chat-mobile-preview-debug.apk", "SHA256SUMS.txt", "provenance.json"})

    def test_bounded_subprocess_output_failure_and_timeout(self):
        self.mock_sdk.stop()
        with self.assertRaises(artifact.VerificationError): artifact.run_sdk([sys.executable, "-c", "print('x'*10000)"], max_output=100)
        with self.assertRaises(artifact.VerificationError): artifact.run_sdk([sys.executable, "-c", "raise SystemExit(4)"])
        with self.assertRaises(artifact.VerificationError): artifact.run_sdk([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.05)
        self.assertEqual(artifact.run_sdk([sys.executable, "-c", "print('bounded')"]).strip(), "bounded")
        with mock.patch.object(artifact.os, "killpg", wraps=os.killpg) as kill_group:
            with self.assertRaises(artifact.VerificationError):
                artifact.run_sdk([sys.executable, "-c", "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)'])"], timeout=0.2)
            self.assertTrue(kill_group.called)
        self.mock_sdk.start()


if __name__ == "__main__":
    unittest.main()
