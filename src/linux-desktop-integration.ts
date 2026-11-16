import { closeSync, constants, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ensureLinuxDesktopEntry, type LinuxDesktopEntryDescription, type LinuxDesktopEntryOptions, type LinuxDesktopEntryResult } from "./linux-desktop-entry";

export interface LinuxDesktopIntegrationPort {
  options: LinuxDesktopEntryOptions;
  current(): boolean;
  confirm(description: LinuxDesktopEntryDescription): Promise<boolean>;
  onResult(result: LinuxDesktopEntryResult, manual: boolean): void;
  onError(manual: boolean): void;
}

export function createLinuxDesktopIntegration(port: LinuxDesktopIntegrationPort): (manual?: boolean) => Promise<void> {
  const options = { ...port.options };
  const marker = join(options.userDataDirectory, "linux-desktop-integration-offered");
  let pending: Promise<void> | null = null;
  const run = async (manual: boolean): Promise<void> => {
    if (!port.current() || options.platform !== "linux" || !options.appImage) return;
    if (!manual && existsSync(marker)) return;
    try {
      let offered = false;
      const result = await ensureLinuxDesktopEntry(options, async (description) => {
        if (!port.current()) return false;
        offered = true;
        const approved = await port.confirm(description);
        return approved && port.current();
      });
      if (!port.current()) return;
      if (offered) {
        // Remember refusal locally, without ever replacing an existing file or following a symlink.
        try { closeSync(openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      }
      port.onResult(result, manual);
    } catch {
      if (port.current()) port.onError(manual);
    }
  };
  return (manual = false) => {
    if (pending) return pending;
    pending = run(manual).finally(() => { pending = null; });
    return pending;
  };
}
