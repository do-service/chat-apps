#!/usr/bin/env python3
"""Verify a CI-built debug APK and stage exactly three public artifacts.

Usage: python3 scripts/android_artifact.py --source ROOT --apk APK --output NEWDIR
       --source-commit SHA40 --workflow-commit SHA40 --build-tools SDK/build-tools/36.0.0

Only Android SDK apksigner/aapt may establish signature/package acceptance. Unit tests
mock them; ZIP/DEX/source checks alone are not real APK, device or IdP acceptance.
Provenance is deliberately unsigned metadata, not an attestation. No upload/signing,
credential access, package installation or source extraction is performed.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import zipfile
import zlib

APP_ID = "ru.exzvps.chat.mobile.preview"
VERSION = "0.1.0-preview.1"
CAPACITOR = "8.6.0"
BUILD_TOOLS = "36.0.0"
APK_NAME = "chat-mobile-preview-debug.apk"
OUTPUT_NAMES = {APK_NAME, "SHA256SUMS.txt", "provenance.json"}
MAX_APK = 256 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_ENTRIES = 20000
MAX_WWW = 128 * 1024 * 1024
CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' chat-resource: wss://chat.exz-vps.ru/livekit wss://chat.exz-vps.ru/livekit/ https://chat.exz-vps.ru/livekit https://chat.exz-vps.ru/livekit/; img-src 'self' data: blob: chat-resource: https:; media-src 'self' blob: chat-resource:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
REQUIRED_CLASSES = {"Lru/exzvps/chat/mobile/preview/" + name + ";" for name in ("ChatMobilePlugin", "GuardedMessageHandler", "ChatRuntime")}
# Verified installed @capacitor/cli8.6.0 cordova.js136-139,218-230: no-plugin
# copy creates ONLY these two EMPTY public files, never arbitrary plugin JS.
EMPTY_CORDOVA = {"assets/public/cordova.js", "assets/public/cordova_plugins.js"}
SDK_PROPERTIES = {name + ".properties" for name in (
    "firebase-annotations", "firebase-appcheck-interop", "firebase-common", "firebase-common-ktx",
    "firebase-components", "firebase-datatransport", "firebase-encoders", "firebase-encoders-json",
    "firebase-encoders-proto", "firebase-iid-interop", "firebase-installations", "firebase-installations-interop",
    "firebase-measurement-connector", "firebase-messaging", "play-services-base", "play-services-basement",
    "play-services-cloud-messaging", "play-services-stats", "play-services-tasks", "transport-api",
    "transport-backend-cct", "transport-runtime", "protolite-well-known-types")}
RAW_SUFFIXES = {".java", ".kt", ".kts", ".ts", ".tsx", ".map", ".go", ".sql", ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".env", ".yaml", ".yml", ".sh", ".class",
                ".py", ".pyc", ".c", ".cc", ".cpp", ".h", ".rs", ".swift", ".p8", ".mobileprovision",
                ".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar", ".apk", ".aab", ".jar", ".aar"}
PRIVATE_PARTS = {".git", ".github", "backend", "frontend", "node_modules", "src", "secrets", "credentials"}


class VerificationError(Exception):
    """A deliberately public-safe validation error; never attach SDK output."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def secure_path(value, directory=False, missing=False):
    path = Path(os.path.abspath(os.fspath(value)))
    for current in (path, *path.parents):
        require(not current.is_symlink(), "symlink path rejected")
    if missing:
        require(not os.path.lexists(path), "output already exists")
        require(path.parent.is_dir(), "output parent missing")
    else:
        require(path.is_dir() if directory else path.is_file(), "required regular path missing")
    return path


def read_small(path, limit=1024 * 1024):
    path = secure_path(path)
    require(path.stat().st_size <= limit, "metadata size limit")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, "metadata size limit")
    return data


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs)
    except (UnicodeError, ValueError, TypeError, RecursionError) as error:
        raise VerificationError("invalid JSON metadata") from error


def canonical_name(name, directory=False):
    require(isinstance(name, str) and 0 < len(name) <= 512, "invalid ZIP path")
    require(re.fullmatch(r"[A-Za-z0-9_.$@+/-]+", name) is not None, "noncanonical ZIP path")
    parts = name[:-1].split("/") if directory and name.endswith("/") else name.split("/")
    require(all(part not in ("", ".", "..") for part in parts), "ZIP traversal rejected")
    require(not any(part.lower() in PRIVATE_PARTS for part in parts), "private source path rejected")
    basename = parts[-1].lower()
    require(Path(basename).suffix not in RAW_SUFFIXES, "raw source or key rejected")
    require(not re.search(r"(?:google-services|service[-_]account|credential|secret|private[-_]key|password|^\.env)", basename), "credential configuration rejected")
    return "/".join(parts)


class BundleHTML(HTMLParser):
    # This accepts the known generated shell, not the HTML5 tree-builder's error
    # recovery. Inert/foreign containers and implicit head closes fail closed.
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    HEAD_CHILDREN = {"meta", "link", "script", "title", "style"}
    INERT_OR_FOREIGN = {"template", "noscript", "svg", "math", "foreignobject", "iframe", "object", "xmp", "plaintext", "textarea", "noframes"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.position = 0
        self.heads = 0
        self.csp = []
        self.scripts = []
        self.stack = []
        self.html_seen = False
        self.head_closed = False
        self.body_seen = False

    def handle_starttag(self, tag, attrs):
        self.position += 1
        require(len({key for key, _ in attrs}) == len(attrs), "duplicate HTML attribute")
        values = dict(attrs)
        require(not any(key.startswith("on") for key in values), "inline HTML handler rejected")
        require(tag not in self.INERT_OR_FOREIGN, "inert or foreign HTML context rejected")
        if tag == "html":
            require(not self.stack and not self.html_seen, "unexpected HTML root")
            self.html_seen = True
        elif tag == "head":
            require(self.stack == ["html"] and not self.heads and not self.body_seen, "unexpected HTML head")
            self.heads += 1
        elif tag == "body":
            require(self.stack == ["html"] and self.head_closed and not self.body_seen, "unexpected HTML body")
            self.body_seen = True
        else:
            if self.stack == ["html", "head"]:
                require(tag in self.HEAD_CHILDREN, "implicit HTML head close rejected")
            else:
                require(self.stack[:2] == ["html", "body"], "nested head content rejected")
            if tag in self.HEAD_CHILDREN:
                require(self.stack == ["html", "head"], "critical HTML tag must be active direct head child")
        if tag == "meta" and str(values.get("http-equiv", "")).lower() == "content-security-policy":
            self.csp.append((self.position, values.get("content")))
        if tag == "script":
            src = values.get("src", "")
            require(isinstance(src, str) and re.fullmatch(r"/[A-Za-z0-9_./@-]+\.m?js", src), "nonlocal script rejected")
            canonical_name(src[1:])
            self.scripts.append((self.position, values))
        if tag not in self.VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        require(tag in self.VOID, "self-closing nonvoid HTML tag rejected")
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        require(tag not in self.VOID and self.stack and self.stack[-1] == tag, "unbalanced HTML shell rejected")
        self.stack.pop()
        if tag == "head":
            self.head_closed = True

    def handle_data(self, data):
        parent = self.stack[-1] if self.stack else None
        if parent == "script":
            require(not data.strip(), "inline script rejected")
        elif parent not in {"title", "style"} and ("head" in self.stack or parent in {None, "html"}):
            require(not data.strip(" \t\n\r\f"), "implicit HTML head/body content rejected")

    def validate(self):
        require(self.html_seen and self.head_closed and not self.stack, "incomplete HTML shell rejected")
        require(self.heads == 1 and len(self.csp) == 1 and self.csp[0][1] == CSP, "bundled CSP mismatch")
        bootstrap = [(position, attrs) for position, attrs in self.scripts if attrs.get("src") == "/mobile-bootstrap.js"]
        modules = [position for position, attrs in self.scripts if attrs.get("type") == "module"]
        require(len(bootstrap) == 1 and bootstrap[0][1] == {"src": "/mobile-bootstrap.js"}, "bootstrap is not blocking classic script")
        require(modules and self.csp[0][0] < bootstrap[0][0] < min(modules), "bootstrap/module ordering mismatch")


def check_config(data):
    config = strict_json(data)
    require(isinstance(config, dict) and set(config) <= {"appId", "appName", "webDir", "server", "plugins"}, "native config keys rejected")
    require((config.get("appId"), config.get("appName"), config.get("webDir")) == (APP_ID, "Chat", "www"), "native config identity mismatch")
    server = config.get("server", {})
    require(isinstance(server, dict) and set(server) <= {"hostname", "androidScheme", "iosScheme", "cleartext"}, "remote native UI rejected")
    require(server.get("hostname") == "localhost" and server.get("androidScheme") == "https" and server.get("cleartext") is False, "native local origin mismatch")
    require(server.get("iosScheme", "capacitor") == "capacitor", "native scheme mismatch")
    require(config.get("plugins") == {"CapacitorHttp": {"enabled": False}, "CapacitorCookies": {"enabled": False}}, "generic native transport rejected")


def source_bundle(source):
    mobile = source / "mobile"
    require(not os.path.lexists(mobile / "android/app/google-services.json"), "Firebase app configuration rejected")
    package = strict_json(read_small(mobile / "package.json"))
    require(isinstance(package, dict), "invalid mobile package metadata")
    require(isinstance(package.get("dependencies", {}), dict) and isinstance(package.get("devDependencies", {}), dict), "invalid dependency metadata")
    dependencies = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    for name in ("@capacitor/core", "@capacitor/android", "@capacitor/cli"):
        require(dependencies.get(name) == CAPACITOR, "Capacitor version mismatch")
    require(not any(name.startswith("cordova-") for name in dependencies), "Cordova plugin dependency rejected")
    for name in ("android", "cli"):
        installed = strict_json(read_small(mobile / f"node_modules/@capacitor/{name}/package.json"))
        require(isinstance(installed, dict) and installed.get("version") == CAPACITOR, "installed Capacitor version mismatch")
    www = secure_path(mobile / "www", directory=True)
    files = {}
    total = 0
    for path in sorted(www.rglob("*")):
        require(not path.is_symlink(), "bundle symlink rejected")
        if path.is_dir():
            continue
        require(path.is_file(), "nonregular bundle entry")
        name = canonical_name(path.relative_to(www).as_posix())
        require(len(files) < 4096 and path.stat().st_size <= 32 * 1024 * 1024, "bundle size limit")
        data = read_small(path, 32 * 1024 * 1024)
        require(name not in {"cordova.js", "cordova_plugins.js"} and not name.startswith("plugins/"), "generated SDK path in original WWW rejected")
        total += len(data)
        require(total <= MAX_WWW, "bundle total size limit")
        files[name] = (len(data), hashlib.sha256(data).hexdigest())
    require({"index.html", "mobile-bootstrap.js", "mobile-native.css"} <= files.keys(), "bundled UI incomplete")
    parser = BundleHTML()
    try:
        parser.feed(read_small(www / "index.html").decode("utf-8"))
        parser.close()
    except (UnicodeError, ValueError) as error:
        raise VerificationError("invalid bundled HTML") from error
    parser.validate()
    for _, attrs in parser.scripts:
        require(attrs["src"][1:] in files, "bundled script missing")
    native = mobile / "android/app/src/main/assets"
    config = read_small(native / "capacitor.config.json")
    check_config(config)
    require(strict_json(read_small(native / "capacitor.plugins.json")) == [], "unexpected native plugins")
    bridge = read_small(mobile / "node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js", MAX_MEMBER)
    native_assets = {"assets/native-bridge.js": (len(bridge), hashlib.sha256(bridge).hexdigest())}
    lines = "".join(digest + "  " + name + "\n" for name, (_, digest) in sorted(files.items()))
    return files, native_assets, {"files": len(files), "bytes": total, "tree_sha256": hashlib.sha256(lines.encode()).hexdigest()}


def run_sdk(command, *, max_output=256 * 1024, timeout=60):
    """Bound stdout+stderr while running only our child process group, never a shell."""
    env = {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8", "LC_ALL": "C"}
    if os.environ.get("JAVA_HOME"):
        env["JAVA_HOME"] = os.environ["JAVA_HOME"]
    process = None
    completed = False
    try:
        process = subprocess.Popen([str(part) for part in command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL, env=env, start_new_session=True, close_fds=True)
        output = bytearray()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                require(remaining > 0, "SDK command timeout")
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    require(len(output) + len(chunk) <= max_output, "SDK output limit")
                    output.extend(chunk)
        remaining = deadline - time.monotonic()
        require(remaining > 0, "SDK command timeout")
        require(process.wait(timeout=remaining) == 0, "SDK command failed")
        text = output.decode("utf-8", errors="strict")
        completed = True
        return text
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise VerificationError("SDK command failed") from error
    finally:
        if process is not None:
            # The wrapper may exit while its Java child still holds stdout. Kill our
            # entire group on failure even if the immediate parent has already exited.
            if not completed or process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()
            if process.stdout is not None:
                process.stdout.close()


def tool_metadata(build_tools, candidate):
    tools = secure_path(build_tools, directory=True)
    properties = read_small(tools / "source.properties", 65536).decode("utf-8")
    require(re.findall(r"(?m)^Pkg\.Revision\s*=\s*([^\r\n]+)\s*$", properties) == [BUILD_TOOLS], "SDK build-tools revision mismatch")
    signer = secure_path(tools / "apksigner")
    aapt = secure_path(tools / "aapt")
    require(os.access(signer, os.X_OK) and os.access(aapt, os.X_OK), "SDK tools not executable")
    signer_version = run_sdk([signer, "version"], max_output=4096).strip()
    aapt_version = run_sdk([aapt, "version"], max_output=4096).strip()
    require(re.fullmatch(r"[0-9][0-9A-Za-z._+-]{0,63}", signer_version), "unrecognized apksigner version")
    require(re.fullmatch(r"Android Asset Packaging Tool, v[0-9A-Za-z._+-]{1,96}", aapt_version), "unrecognized aapt version")
    verified = run_sdk([signer, "verify", "--verbose", "--print-certs", candidate])
    require(re.search(r"(?m)^Verifies\s*$", verified), "APK signature not verified")
    require(re.findall(r"(?m)^Number of signers: ([0-9]+)\s*$", verified) == ["1"], "unexpected APK signers")
    require(re.search(r"(?m)^Verified using v2 scheme \(APK Signature Scheme v2\): true\s*$", verified), "APK v2 signature required")
    subjects = re.findall(r"(?m)^Signer #1 certificate DN: ([^\r\n]+)", verified)
    digests = re.findall(r"(?m)^Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$", verified)
    require(len(subjects) == len(digests) == 1, "missing APK certificate metadata")
    require(sorted(part.strip() for part in subjects[0].split(",")) == ["C=US", "CN=Android Debug", "O=Android"], "non-debug signing identity rejected")
    badging = run_sdk([aapt, "dump", "badging", candidate])
    packages = re.findall(r"(?m)^package: ([^\r\n]+)", badging)
    require(len(packages) == 1, "missing package metadata")
    fields = dict(re.findall(r"([A-Za-z][A-Za-z0-9]*)='([^']*)'", packages[0]))
    require((fields.get("name"), fields.get("versionName"), fields.get("versionCode")) == (APP_ID, VERSION, "1"), "APK package/version mismatch")
    require(re.findall(r"(?m)^sdkVersion:'([0-9]+)'\s*$", badging) == ["24"], "APK min SDK mismatch")
    require(re.findall(r"(?m)^targetSdkVersion:'([0-9]+)'\s*$", badging) == ["36"], "APK target SDK mismatch")
    require(re.search(r"(?m)^application-debuggable\s*$", badging), "APK must be debuggable")
    require(re.search(r"(?m)^application-label:'Chat'\s*$", badging), "APK display name mismatch")
    resources = run_sdk([aapt, "dump", "resources", candidate], max_output=8 * 1024 * 1024)
    require(not re.search(r":string/(?:google_app_id|gcm_defaultSenderId|google_api_key|default_web_client_id|firebase_database_url|google_storage_bucket)\b", resources), "compiled Firebase configuration rejected")
    return {"build_tools": BUILD_TOOLS, "apksigner": signer_version, "aapt": aapt_version, "python": platform.python_version()}, digests[0].lower()


def dex_classes(data):
    require(len(data) >= 112 and data[:8] in {b"dex\n" + version + b"\0" for version in (b"035", b"037", b"038", b"039", b"040")}, "unsupported DEX header")
    integer = lambda offset: struct.unpack_from("<I", data, offset)[0]
    require((integer(32), integer(36), integer(40)) == (len(data), 112, 0x12345678), "invalid DEX bounds")
    require(hashlib.sha1(data[32:]).digest() == data[12:32] and zlib.adler32(data[12:]) & 0xFFFFFFFF == integer(8), "invalid DEX integrity")
    strings, string_offset = integer(56), integer(60)
    types, type_offset = integer(64), integer(68)
    classes, class_offset = integer(96), integer(100)
    require(strings <= 2000000 and types <= 65535 and classes <= 65535, "DEX table limit")
    for count, offset, width in [(strings, string_offset, 4), (types, type_offset, 4), (classes, class_offset, 32)]:
        require(offset >= 112 and offset + count * width <= len(data), "invalid DEX table bounds")
    result = set()
    for index in range(classes):
        type_index = integer(class_offset + index * 32)
        require(type_index < types, "invalid DEX class index")
        string_index = integer(type_offset + type_index * 4)
        require(string_index < strings, "invalid DEX string index")
        offset = integer(string_offset + string_index * 4)
        require(112 <= offset < len(data), "invalid DEX string offset")
        for _ in range(5):
            require(offset < len(data), "invalid DEX string length")
            byte = data[offset]
            offset += 1
            if byte < 128:
                break
        else:
            raise VerificationError("invalid DEX string length")
        end = data.find(b"\0", offset, min(offset + 8192, len(data)))
        require(end >= offset, "invalid DEX descriptor")
        descriptor = data[offset:end].decode("ascii", errors="replace")
        if descriptor in REQUIRED_CLASSES:
            result.add(descriptor)
    return result


def package_member(name):
    if name in {"AndroidManifest.xml", "resources.arsc", "DebugProbesKt.bin"} or re.fullmatch(r"classes(?:[2-9]|[1-9][0-9]+)?\.dex", name):
        return True
    if name in SDK_PROPERTIES:
        return True
    if re.fullmatch(r"res/[a-z0-9_-]+/[A-Za-z0-9_.-]+\.(?:xml|png|webp|jpg|jpeg|gif|ttf|otf)", name):
        return True
    if re.fullmatch(r"lib/(?:arm64-v8a|armeabi-v7a|x86|x86_64)/lib[A-Za-z0-9_.-]+\.so", name):
        return True
    if re.fullmatch(r"kotlin/[A-Za-z0-9_/-]+\.kotlin_builtins", name):
        return True
    return re.fullmatch(r"META-INF/(?:MANIFEST\.MF|[A-Z0-9_-]{1,32}\.(?:SF|RSA|DSA|EC)|[A-Za-z0-9_.-]+\.(?:version|kotlin_module)|(?:LICENSE|NOTICE)(?:\.[A-Za-z0-9_.-]+)?|com/android/build/gradle/app-metadata\.properties|services/[A-Za-z0-9_.$-]+)", name) is not None


def inspect_apk(candidate, source_files, native_assets):
    seen, found, total = set(), set(), 0
    with zipfile.ZipFile(candidate) as archive:
        require(not archive.comment and len(archive.infolist()) <= MAX_ENTRIES, "APK ZIP metadata limit")
        files = {}
        for info in archive.infolist():
            name = canonical_name(info.filename, info.is_dir())
            require(info.orig_filename == info.filename and name.casefold() not in seen, "duplicate or truncated ZIP path")
            seen.add(name.casefold())
            mode = info.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR) and not stat.S_ISLNK(mode), "nonregular ZIP entry")
            require(not info.comment and not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported ZIP encoding")
            require(info.file_size <= MAX_MEMBER and info.file_size <= max(info.compress_size, 1) * 500, "APK member size/compression limit")
            total += info.file_size
            require(total <= MAX_TOTAL, "APK total size limit")
            if info.is_dir():
                require(name.split("/", 1)[0] in {"assets", "res", "META-INF", "kotlin", "lib"} and info.file_size == 0, "unexpected ZIP directory")
            else:
                files[name] = info
        for name in files:
            require(not any("/".join(name.split("/")[:i]) in files for i in range(1, len(name.split("/")))), "ZIP file/directory collision")
        required = {"AndroidManifest.xml", "resources.arsc", "classes.dex", "assets/capacitor.config.json", "assets/capacitor.plugins.json", "assets/native-bridge.js"}
        expected = {"assets/public/" + name: value for name, value in source_files.items()}
        expected.update(native_assets)
        require(required | expected.keys() <= files.keys(), "APK assets/package incomplete")
        for name, info in files.items():
            require(name in expected or name in EMPTY_CORDOVA or name in {"assets/capacitor.config.json", "assets/capacitor.plugins.json"} or package_member(name), "unexpected APK member")
            if name in EMPTY_CORDOVA and name not in expected:
                require(info.file_size == 0, "nonempty Cordova generated extra")
            digest = hashlib.sha256()
            length = 0
            keep = name.endswith(".dex") or name in {"assets/capacitor.config.json", "assets/capacitor.plugins.json"} or name in SDK_PROPERTIES
            collected = bytearray()
            with archive.open(info) as stream:
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    length += len(chunk)
                    require(length <= MAX_MEMBER and length <= info.file_size, "APK inflated member limit")
                    digest.update(chunk)
                    if keep:
                        collected.extend(chunk)
            require(length == info.file_size, "APK member length mismatch")
            if name in expected:
                require((length, digest.hexdigest()) == expected[name], "APK bundled asset mismatch")
            if name.endswith(".dex"):
                found.update(dex_classes(bytes(collected)))
            elif name == "assets/capacitor.config.json":
                check_config(bytes(collected))
            elif name == "assets/capacitor.plugins.json":
                require(strict_json(bytes(collected)) == [], "APK native plugins rejected")
            elif name in SDK_PROPERTIES:
                require(length <= 16384 and re.fullmatch(rb"[A-Za-z0-9_.=+\- \r\n]*", collected), "unexpected SDK property content")
        require(found == REQUIRED_CLASSES, "native ChatMobile class definitions missing")


def checked_cleanup(root, expected_parent, allowed):
    require(root.resolve() == root and root.parent == expected_parent and not root.is_symlink(), "unsafe temporary cleanup path")
    for path in root.iterdir():
        require(path.name in allowed and path.is_file() and not path.is_symlink(), "unexpected cleanup entry")
    for path in root.iterdir():
        path.unlink()
    root.rmdir()


def stage_output(output, candidate, provenance):
    output.mkdir(mode=0o700)
    try:
        with (output / APK_NAME).open("xb") as destination, candidate.open("rb") as source:
            shutil.copyfileobj(source, destination, 65536)
        encoded = (json.dumps(provenance, sort_keys=True, indent=2) + "\n").encode()
        with (output / "provenance.json").open("xb") as destination:
            destination.write(encoded)
        sums = provenance["apk"]["sha256"] + "  " + APK_NAME + "\n" + hashlib.sha256(encoded).hexdigest() + "  provenance.json\n"
        with (output / "SHA256SUMS.txt").open("x", encoding="utf-8") as destination:
            destination.write(sums)
        require({path.name for path in output.iterdir()} == OUTPUT_NAMES, "unexpected output artifact")
    except Exception:
        checked_cleanup(output, output.parent, OUTPUT_NAMES)
        raise


def prepare(*, source, apk, output, source_commit, workflow_commit, build_tools):
    require(re.fullmatch(r"[0-9a-f]{40}", source_commit) and re.fullmatch(r"[0-9a-f]{40}", workflow_commit), "commit must be exact lowercase SHA40")
    source = secure_path(source, directory=True)
    apk = secure_path(apk)
    output = secure_path(output, missing=True)
    require(not output.is_relative_to(source), "artifact output must be outside private export")
    size = apk.stat().st_size
    require(0 < size <= MAX_APK, "APK file size limit")
    source_files, native_assets, bundle = source_bundle(source)
    temporary = Path(tempfile.mkdtemp(prefix="chat-android-verify-")).resolve()
    parent = Path(tempfile.gettempdir()).resolve()
    require(temporary.parent == parent and temporary.name.startswith("chat-android-verify-"), "unsafe temporary directory")
    try:
        candidate = temporary / "candidate.apk"
        digest = hashlib.sha256()
        copied = 0
        with apk.open("rb") as source_stream, candidate.open("xb") as destination:
            while True:
                chunk = source_stream.read(65536)
                if not chunk:
                    break
                copied += len(chunk)
                require(copied <= MAX_APK, "APK copy size limit")
                digest.update(chunk)
                destination.write(chunk)
        require(copied == size, "APK changed during snapshot")
        candidate.chmod(0o400)
        inspect_apk(candidate, source_files, native_assets)
        tools, certificate = tool_metadata(build_tools, candidate)
        require(hashlib.sha256(candidate.read_bytes()).hexdigest() == digest.hexdigest(), "verified APK snapshot changed")
        provenance = {"schema_version": 1, "provenance_signed": False, "statement": "Unsigned build metadata; not an attestation or Android/device acceptance.",
                      "source_commit": source_commit, "workflow_commit": workflow_commit, "capacitor_version": CAPACITOR,
                      "package": {"application_id": APP_ID, "version_name": VERSION, "version_code": 1, "min_sdk": 24, "target_sdk": 36, "debuggable": True},
                      "signing": {"apk_signature_verified": True, "certificate_sha256": certificate, "debug_subject": "CN=Android Debug, O=Android, C=US", "trusted_release_identity": False},
                      "apk": {"name": APK_NAME, "bytes": copied, "sha256": digest.hexdigest()}, "tools": tools, "bundle": bundle,
                      "acceptance": {"android_device": False, "idp": False, "fcm_delivery": False, "play_release": False}}
        stage_output(output, candidate, provenance)
        return provenance
    except VerificationError:
        raise
    except (OSError, ValueError, TypeError, KeyError, struct.error, zipfile.BadZipFile, RuntimeError) as error:
        raise VerificationError("APK artifact verification failed") from error
    finally:
        checked_cleanup(temporary, parent, {"candidate.apk"})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("source", "apk", "output", "source-commit", "workflow-commit", "build-tools"):
        parser.add_argument("--" + option, required=True)
    args = parser.parse_args(argv)
    try:
        prepare(**vars(args))
        print(json.dumps({"files": sorted(OUTPUT_NAMES)}, separators=(",", ":")))
        return 0
    except (VerificationError, OSError, ValueError, TypeError, KeyError):
        print("android-artifact: verification failed; no public artifact was accepted", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
