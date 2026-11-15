import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { isRecord } from "./contract";

type SignatureOptions = { timeout: number; maxBuffer: number; windowsHide: boolean; shell: false; encoding: "utf8"; env: NodeJS.ProcessEnv };
export type SignatureRunner = (executable: string, args: string[], options: SignatureOptions) => Promise<{ stdout: string; stderr: string }>;
const runSignature: SignatureRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, args, options, (error, stdout, stderr) => {
    if (error) reject(new Error("Windows signature verification unavailable")); else resolve({ stdout, stderr });
  });
});
const script = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$s = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:CHAT_UPDATE_VERIFY_FILE -ErrorAction Stop",
  "if ($s.Status -ne 0 -or $null -eq $s.SignerCertificate) { exit 2 }",
  "[pscustomobject]@{ Status = [int]$s.Status; Path = $s.Path; Subject = $s.SignerCertificate.Subject; Publisher = $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress",
].join("; ");

export async function verifyWindowsSignature(
  publishers: string[], path: string, run: SignatureRunner = runSignature, systemRoot = process.env.SystemRoot ?? "C:\\Windows",
): Promise<string | null> {
  const failed = "Windows installer signature could not be verified";
  if (!/^[A-Za-z]:\\[A-Za-z0-9 _.-]+$/.test(systemRoot) || !win32.isAbsolute(path) || path.startsWith("\\\\")
    || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path) || publishers.length === 0 || publishers.length > 16
    || !publishers.every((name) => name.trim().length > 0 && name.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(name))) return failed;
  const home = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  try {
    const result = await run(win32.join(home, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      timeout: 20_000, maxBuffer: 16 * 1024, windowsHide: true, shell: false, encoding: "utf8",
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PSModulePath: win32.join(home, "Modules"), CHAT_UPDATE_VERIFY_FILE: path },
    });
    if (result.stderr.trim() || result.stdout.length > 16 * 1024) return failed;
    const value: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    if (!isRecord(value) || Object.keys(value).length !== 4 || value.Status !== 0 || typeof value.Path !== "string"
      || win32.normalize(value.Path).toLowerCase() !== win32.normalize(path).toLowerCase()
      || typeof value.Subject !== "string" || value.Subject.length === 0 || value.Subject.length > 4096
      || typeof value.Publisher !== "string" || value.Publisher.length === 0 || value.Publisher.length > 256) return failed;
    return publishers.some((name) => name === value.Subject || name === value.Publisher) ? null : failed;
  } catch { return failed; }
}
