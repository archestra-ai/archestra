import type { DesktopDevice } from "@/lib/desktop-device.query";
import {
  desktopServerErrorSentence,
  deviceServerStateLabel,
} from "@/lib/mcp/desktop-mcp";
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

/**
 * The MCP Servers column of a device: how many of its MCP servers run, and
 * how many failed when any did. Null for an offline device: its MCP bridge
 * reports no states, so none are known.
 */
export function deviceServersLabel(
  device: Pick<DesktopDevice, "online" | "servers">,
): { running: string; failed: string | null } | null {
  if (!device.online) return null;
  const count = (state: DesktopServer["state"]) =>
    device.servers.filter((server) => server.state === state).length;
  const failed = count("failed");
  return {
    running: `${count("running")} running`,
    failed: failed > 0 ? `${failed} failed` : null,
  };
}

/**
 * The MCP servers of an online device, as its open row lists them: failed
 * ones first, then the others in the order the device has them. A failed
 * server has its error as one plain sentence, as the MCP Registry shows it.
 */
export function deviceServerRows(servers: DesktopServer[]): DeviceServerRow[] {
  const failed = servers.filter((server) => server.state === "failed");
  const others = servers.filter((server) => server.state !== "failed");
  return [...failed, ...others].map((server) => {
    const error =
      server.state === "failed"
        ? desktopServerErrorSentence({
            error: server.lastError,
            name: server.name,
            command: server.command,
            url: server.url,
          })
        : null;
    return {
      catalogId: server.catalogId,
      name: server.name,
      state: deviceServerStateLabel(server.state),
      failed: server.state === "failed",
      running: server.state === "running",
      error,
    };
  });
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
  device: Pick<DesktopDevice, "programUpdate" | "programAutoUpdate">,
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

type DesktopServer = DesktopDevice["servers"][number];

interface DeviceServerRow {
  catalogId: string;
  name: string;
  /** "Running", "Failed" and so on; null when the MCP bridge reported none. */
  state: string | null;
  failed: boolean;
  running: boolean;
  /** Why it failed, as one plain sentence. */
  error: string | null;
}

/** For a value the MCP bridge did not send yet. */
const NOT_REPORTED = "Not reported";

const PLATFORM_LABEL: Record<DesktopDevice["platform"], string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};
