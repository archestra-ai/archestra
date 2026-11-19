import type { DesktopDevice } from "@/lib/desktop-device.query";
import { programUpdateInstruction } from "@/lib/mcp/mcp-bridge-command";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

interface DeviceProgramUpdateNotice {
  title: string;
  /** The explanation: the command to run, and the words around it. */
  text: { before: string; command: string; after: string };
}

/**
 * The Status column of a device. An offline device also says when it was
 * last online: an online one is online now, so it needs no time.
 */
export function deviceStatusLabel(
  device: Pick<DesktopDevice, "online" | "lastPolledAt">,
): { status: string; lastOnline: string | null } {
  if (device.online) return { status: "Online", lastOnline: null };
  return {
    status: "Offline",
    lastOnline: device.lastPolledAt
      ? `Last online ${formatRelativeTimeFromNow(device.lastPolledAt, { strict: true })}`
      : null,
  };
}

/** The Platform column of a device. */
export function devicePlatformLabel(
  platform: DesktopDevice["platform"],
): string {
  return PLATFORM_LABEL[platform];
}

/** The Version column of a device: the version its MCP bridge reported. */
export function deviceProgramVersionLabel(
  version: DesktopDevice["programVersion"],
): string {
  return version ?? NOT_REPORTED;
}

/**
 * The notice of a device whose MCP bridge is not the version this deployment
 * serves, or null when there is nothing to update. The text is in three
 * parts, so the page can show the command as code.
 *
 * See {@link programUpdateInstruction} for who runs the command.
 */
export function deviceProgramUpdateNotice(
  device: Pick<
    DesktopDevice,
    "platform" | "programUpdate" | "programAutoUpdate"
  >,
): DeviceProgramUpdateNotice | null {
  if (!device.programUpdate) return null;
  const { version } = device.programUpdate;
  return {
    title: version
      ? `A new version of the MCP bridge (${version}) is available`
      : "A new version of the MCP bridge is available",
    text: programUpdateInstruction(device),
  };
}

// ===

/** For a value the MCP bridge did not send yet. */
const NOT_REPORTED = "Not reported";

const PLATFORM_LABEL: Record<DesktopDevice["platform"], string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};
