import {
  type archestraApiTypes,
  DESKTOP_MCP_ARGUMENTS_MIN_PROGRAM_VERSION,
  programAppliesDesktopMcpArguments,
} from "@archestra/shared";
import { programUpdateInstruction } from "./mcp-bridge-command";

type DesktopDevice =
  archestraApiTypes.GetDesktopDevicesResponses["200"][number];

/**
 * How a computer gets a desktop MCP server: it starts the server with a
 * command, or it connects to a URL where the server already listens. A server
 * has one of the two, never both.
 */
export type DesktopMcpTargetKind = "command" | "url";

/**
 * The words a desktop MCP item uses where other items say Install, Uninstall,
 * Installed and Installations: the server is added to the user's own
 * computer, not installed in the app. A device is linked to the user's
 * account; an MCP server is connected from the linked device to the app.
 */
export const DESKTOP_MCP_COPY = {
  add: "Connect",
  /** The Connect action of a user who has no MCP bridge yet: it sets it up first. */
  addWithBridge: "Install MCP bridge and connect",
  adding: "Connecting...",
  remove: "Disconnect",
  removeTheirs: "Disconnect from their device",
  removing: "Disconnecting...",
  added: "Connected",
  /** The status in the header of the server's page. */
  addedFromDevice: "Connected from your device",
  waiting: "Waiting for your device",
  noDevice: "Device not linked",
  notAdded: "Not connected from your device",
  section: "Devices",
} as const;

/**
 * Whether the registry form offers Desktop hosting. Desktop MCP is in alpha:
 * only with the beta flag, except for an item that already is one, which
 * keeps its choice.
 */
export function desktopHostingOffered(params: {
  betaEnabled: boolean;
  current: string | undefined;
}): boolean {
  return params.betaEnabled || params.current === "desktop_mcp";
}

/** The Device tab of Personal Settings: the user's device. */
export const DEVICES_HREF = "/account/devices";

/**
 * Which of the two a pair of stored values holds. A pair with neither reads as
 * a command: that is the choice a new entry starts with.
 */
export function desktopMcpTargetOf(values: {
  command?: string | null;
  url?: string | null;
}): { kind: DesktopMcpTargetKind; value: string } {
  if (!values.command && values.url) {
    return { kind: "url", value: values.url };
  }
  return { kind: "command", value: values.command ?? "" };
}

/**
 * The `command` and `url` to send for one choice. The value that is not chosen
 * is null, and so is an empty one: the backend rejects a command together with
 * a URL, and null is how it removes a value.
 */
export function desktopMcpTargetToApi(target: {
  kind: DesktopMcpTargetKind;
  value: string;
}): { command: string | null; url: string | null } {
  const value = target.value.trim();
  return {
    command: target.kind === "command" && value ? value : null,
    url: target.kind === "url" && value ? value : null,
  };
}

/** Why a typed command or URL cannot be saved, or null when it can. */
export function desktopMcpTargetError(target: {
  kind: DesktopMcpTargetKind;
  value: string;
}): string | null {
  const value = target.value.trim();
  if (!value) return null;
  if (value.length > DESKTOP_MCP_TARGET_MAX_LENGTH) {
    return `Use at most ${DESKTOP_MCP_TARGET_MAX_LENGTH} characters.`;
  }
  if (target.kind === "url" && !isHttpUrl(value)) {
    return "The URL must start with http:// or https://";
  }
  return null;
}

/**
 * The command of a desktop MCP catalog item, exactly as its admin stored it;
 * null for an item that has none (it is not set up, or it is stored with a
 * URL). Only an item with a command takes arguments from its user.
 */
export function desktopMcpCommandOf(
  desktopConfig: { command?: string | null } | null | undefined,
): string | null {
  const command = desktopConfig?.command;
  return command?.trim() ? command : null;
}

/**
 * Why the arguments a user typed for their desktop MCP server cannot be
 * saved, or null when they can. The limits are the backend's.
 */
export function desktopMcpArgumentsError(values: string[]): string | null {
  if (values.length > DESKTOP_MCP_ARGUMENTS_MAX_COUNT) {
    return `Use at most ${DESKTOP_MCP_ARGUMENTS_MAX_COUNT} arguments.`;
  }
  if (values.some((value) => value.length > DESKTOP_MCP_TARGET_MAX_LENGTH)) {
    return `Use at most ${DESKTOP_MCP_TARGET_MAX_LENGTH} characters in one argument.`;
  }
  const total = values.reduce((sum, value) => sum + value.length, 0);
  if (total > DESKTOP_MCP_ARGUMENTS_MAX_TOTAL_LENGTH) {
    return `Use at most ${DESKTOP_MCP_ARGUMENTS_MAX_TOTAL_LENGTH} characters in all arguments together.`;
  }
  return null;
}

/**
 * What a dialog says about arguments when the viewer's device cannot apply
 * them. The text is in three parts, so the dialog can show a command as
 * code; `command` is null when there is none to run.
 */
export interface DesktopArgumentsProgramNotice {
  title: string;
  text: { before: string; command: string | null; after: string };
}

/**
 * The notice for a viewer whose device runs a program from before the
 * arguments: its MCP bridge starts the command with none of them. The
 * arguments are stored all the same, and apply once the device runs a newer
 * program. Null when there is nothing to say:
 * - the viewer has no device;
 * - the device was linked a moment ago and has not reported yet, so its
 *   version is not known;
 * - the program of the device applies arguments.
 *
 * The notice names `archestra update` only when the deployment serves a
 * program that applies arguments: with an older one served, the command
 * would get that older one again.
 */
export function desktopArgumentsProgramNotice(params: {
  device:
    | Pick<
        DesktopDevice,
        | "name"
        | "platform"
        | "lastPolledAt"
        | "programVersion"
        | "programUpdate"
        | "programAutoUpdate"
      >
    | null
    | undefined;
  appName: string;
}): DesktopArgumentsProgramNotice | null {
  const { device, appName } = params;
  if (!device || device.lastPolledAt === null) return null;
  if (programAppliesDesktopMcpArguments(device.programVersion)) return null;

  const title = "Arguments need a newer version of the MCP bridge";
  const needs = `${
    device.programVersion
      ? `The MCP bridge on ${device.name} is version ${device.programVersion}.`
      : `The MCP bridge on ${device.name} did not report its version.`
  } Arguments need version ${DESKTOP_MCP_ARGUMENTS_MIN_PROGRAM_VERSION} or newer.`;
  if (programAppliesDesktopMcpArguments(device.programUpdate?.version)) {
    const update = programUpdateInstruction(device);
    return {
      title,
      text: {
        before: `${needs} ${update.before}`,
        command: update.command,
        after: `${update.after} Arguments are saved and apply after the update.`,
      },
    };
  }
  return {
    title,
    text: {
      before: `${needs} ${appName} does not offer that version yet. Arguments are saved and apply once the device has it.`,
      command: null,
      after: "",
    },
  };
}

/**
 * Adds a desktop MCP catalog item to the caller's own computer, through the
 * caller's install mutation. The installation is always personal: the server
 * runs on the computer of the user who adds it. Resolves with the
 * installation, which the Add dialog then follows, or with null when it was
 * refused (a toast says why) and the dialog stays for another try.
 *
 * `desktopArguments` are what the caller adds to the command of the item.
 * They are sent only when given: an item with no command takes none, and
 * an installation the caller has already keeps its arguments.
 */
export async function addDesktopMcpServer<Server>(params: {
  install: (body: {
    name: string;
    catalogId: string;
    scope: "personal";
    dontShowToast: true;
    desktop: true;
    desktopArguments?: string[];
  }) => Promise<{ installedServer?: Server; errorMessage: string | null }>;
  catalogItem: { id: string; name: string };
  desktopArguments?: string[];
}): Promise<Server | null> {
  const { install, catalogItem, desktopArguments } = params;
  const result = await install({
    name: catalogItem.name,
    catalogId: catalogItem.id,
    scope: "personal",
    dontShowToast: true,
    desktop: true,
    ...(desktopArguments ? { desktopArguments } : {}),
  });
  return result.errorMessage ? null : (result.installedServer ?? null);
}

/**
 * The desktop MCP servers the viewer added to their computer, by name, each
 * ready (its tools were read) or still waiting for the computer. Read from
 * the registry's issue index, which every page has: a server added before
 * the MCP bridge exists is listed too.
 */
export function ownDesktopMcpServers(params: {
  catalogItems:
    | {
        id: string;
        name: string;
        serverType: string;
        icon?: string | null;
        iconUrl?: string | null;
      }[]
    | undefined;
  servers:
    | {
        catalogId: string;
        ownerId: string | null;
        scope: string;
        localInstallationStatus: string;
      }[]
    | undefined;
  viewerId: string | null | undefined;
}): { catalogId: string; name: string; icon: string | null; ready: boolean }[] {
  const { catalogItems, servers, viewerId } = params;
  if (!viewerId || !catalogItems || !servers) return [];
  const desktopItems = new Map(
    catalogItems
      .filter((item) => item.serverType === "desktop_mcp")
      .map((item) => [item.id, item]),
  );
  return servers
    .filter(
      (server) =>
        server.ownerId === viewerId &&
        server.scope === "personal" &&
        desktopItems.has(server.catalogId),
    )
    .map((server) => {
      const item = desktopItems.get(server.catalogId);
      return {
        catalogId: server.catalogId,
        name: item?.name ?? "",
        icon: item?.iconUrl ?? item?.icon ?? null,
        ready: server.localInstallationStatus === "success",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The state the MCP bridge reports for a server; null when it reported none.
 */
function deviceServerStateLabel(
  state: string | null | undefined,
): string | null {
  return state && state in DEVICE_SERVER_STATE_LABEL
    ? DEVICE_SERVER_STATE_LABEL[state as DeviceServerState]
    : null;
}

/**
 * A server the user linked, right after their device connects. A server the
 * MCP bridge did not report yet is about to start.
 */
export function desktopServerStartLabel(
  state: string | null | undefined,
): string {
  return deviceServerStateLabel(state) ?? DEVICE_SERVER_STATE_LABEL.starting;
}

/**
 * Why a server did not start, as one plain sentence. The MCP bridge reports
 * the error of the operating system or of the server as it got it; the
 * common ones are worded here, and any other is returned as it came. Null
 * when there is no error.
 */
export function desktopServerErrorSentence(params: {
  error: string | null | undefined;
  name: string;
  command?: string | null;
  url?: string | null;
}): string | null {
  const error = params.error?.trim();
  if (!error) return null;
  const { name, url } = params;

  if (error.startsWith("cannot start the program")) {
    const program = programOf(params.command);
    const subject = program ? `The program "${program}"` : "The program";
    if (PROGRAM_NOT_FOUND.test(error)) {
      return `${subject} was not found on this device.`;
    }
    if (PROGRAM_NOT_ALLOWED.test(error)) {
      return `${subject} is not allowed to run on this device.`;
    }
    return `${subject} could not start on this device.`;
  }
  if (error.includes("closed before it answered")) {
    return `${name} closed right after it started.`;
  }
  if (error.includes("did not answer `initialize` in time")) {
    return `${name} started, but did not answer in time.`;
  }
  if (error.includes("answered `initialize` with an error")) {
    return `${name} started, but answered with an error.`;
  }
  if (error.startsWith("the MCP server stopped")) {
    return `${name} stopped by itself.`;
  }
  if (error.startsWith("the request failed")) {
    return url
      ? `Nothing answers at ${url} on this device.`
      : `${name} does not answer on this device.`;
  }
  if (error.includes("did not accept the handshake")) {
    return `${name} did not accept the connection.`;
  }
  if (error.includes("quote that is not closed")) {
    return "The command has a quote that is not closed.";
  }
  return error;
}

// ===

type DeviceServerState = DesktopDevice["servers"][number]["state"];

const DEVICE_SERVER_STATE_LABEL: Record<DeviceServerState, string> = {
  no_command: "No command",
  starting: "Starting",
  running: "Running",
  failed: "Failed",
  stopped: "Stopped",
};

/** "No such file or directory (os error 2)", and what Windows says for it. */
const PROGRAM_NOT_FOUND =
  /no such file or directory|cannot find the (file|path)|program not found|\(os error 2\)/i;
/** "Permission denied (os error 13)", and what Windows says for it. */
const PROGRAM_NOT_ALLOWED = /permission denied|access is denied/i;

/** The program a command starts: its first word, without its quotes. */
function programOf(command: string | null | undefined): string | null {
  const text = command?.trim();
  if (!text) return null;
  const quote = text[0] === '"' || text[0] === "'" ? text[0] : null;
  if (quote) {
    const end = text.indexOf(quote, 1);
    return end > 1 ? text.slice(1, end) : null;
  }
  return text.split(/\s+/)[0] ?? null;
}

/** The limit the backend sets for a command, a URL and one argument. */
const DESKTOP_MCP_TARGET_MAX_LENGTH = 4096;
/** The limits the backend sets for the arguments of one installation. */
const DESKTOP_MCP_ARGUMENTS_MAX_COUNT = 64;
const DESKTOP_MCP_ARGUMENTS_MAX_TOTAL_LENGTH =
  4 * DESKTOP_MCP_TARGET_MAX_LENGTH;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
