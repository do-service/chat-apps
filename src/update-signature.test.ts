import assert from "node:assert/strict";
import test from "node:test";
import { verifyWindowsSignature, type SignatureRunner } from "./update-signature";
const file = "C:\\Users\\User\\Updates\\Chat's installer.exe";
const valid = { Status: 0, Path: file, Subject: "CN=Chat Publisher, O=Chat", Publisher: "Chat Publisher" };
const run = (value: unknown): SignatureRunner => async () => ({ stdout: JSON.stringify(value), stderr: "" });

test("Windows signature verifier uses absolute bounded shell-free PowerShell and exact valid publisher/path", async () => {
  let calls = 0;
  const runner: SignatureRunner = async (executable, args, options) => {
    calls++; assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(options.shell, false); assert.equal(options.timeout, 20_000); assert.equal(options.maxBuffer, 16 * 1024);
    assert.equal(options.env.CHAT_UPDATE_VERIFY_FILE, file); assert.equal(args.includes(file), false);
    const command = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    assert.match(command, /Get-AuthenticodeSignature -LiteralPath \$env:CHAT_UPDATE_VERIFY_FILE/);
    assert.equal(command.includes(file), false);
    return { stdout: JSON.stringify(valid), stderr: "" };
  };
  assert.equal(await verifyWindowsSignature(["Chat Publisher"], file, runner), null);
  assert.equal(await verifyWindowsSignature([valid.Subject], file, run(valid)), null); assert.equal(calls, 1);
});

test("missing/blocked PowerShell, stderr, malformed JSON or incomplete result always fail closed", async () => {
  const failures: SignatureRunner[] = [
    async () => { throw Object.assign(new Error("PowerShell unavailable"), { code: "ENOENT" }); },
    async () => { throw new Error("Get-AuthenticodeSignature blocked"); },
    async () => ({ stdout: JSON.stringify(valid), stderr: "ConvertTo-Json error" }),
    async () => ({ stdout: "not JSON", stderr: "" }),
    run(null), run({}), run({ ...valid, Status: 1 }), run({ ...valid, Path: "C:\\different.exe" }),
    run({ ...valid, Publisher: "Chat Publisher Other", Subject: "CN=Other" }), run({ ...valid, Path: null }),
    async () => ({ stdout: "x".repeat(16385), stderr: "" }),
  ];
  for (const runner of failures) assert.notEqual(await verifyWindowsSignature(["Chat Publisher"], file, runner), null);
  for (const publishers of [[], [""], ["Chat Publisher\n"]]) assert.notEqual(await verifyWindowsSignature(publishers, file, run(valid)), null);
  assert.notEqual(await verifyWindowsSignature(["Chat Publisher"], file, run(valid), "relative-root"), null);
});
