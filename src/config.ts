import { createHash } from "node:crypto";
import { isRecord } from "./contract";
import { SPIKE_ORIGIN, SPIKE_URL, validateAppURL } from "./security";

export type RuntimeConfiguration = {
  spike: boolean;
  appURL: string;
  trustedOrigin: string;
  profileKey: string;
  partition: string;
};

export function parseBuildConfiguration(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("appUrl" in value)) {
    throw new Error("Invalid desktop build configuration");
  }
  if (value.appUrl === null) return null;
  return validateAppURL(value.appUrl);
}

export function resolveConfiguration(
  args: string[], environmentURL: string | undefined, buildConfiguration: unknown,
): RuntimeConfiguration {
  let diagnosticBuild = false;
  let builtURL: string | null = null;
  if (isRecord(buildConfiguration) && "spike" in buildConfiguration) {
    if (Object.keys(buildConfiguration).length !== 2 || buildConfiguration.spike !== true || buildConfiguration.appUrl !== null) {
      throw new Error("Invalid diagnostic desktop build configuration");
    }
    diagnosticBuild = true;
  } else if (buildConfiguration !== undefined) {
    builtURL = parseBuildConfiguration(buildConfiguration);
  }
  const spike = args.includes("--spike") || diagnosticBuild;
  let appURL: string;
  if (spike) {
    appURL = SPIKE_URL;
  } else {
    const configured = environmentURL !== undefined
      ? validateAppURL(environmentURL) : builtURL;
    if (!configured) throw new Error("DESKTOP_APP_URL is required outside explicit --spike mode");
    appURL = configured;
  }
  const trustedOrigin = spike ? SPIKE_ORIGIN : new URL(appURL).origin;
  const profileKey = createHash("sha256").update(trustedOrigin).digest("hex");
  return { spike, appURL, trustedOrigin, profileKey, partition: `persist:chat-desktop-v1-${profileKey}` };
}
