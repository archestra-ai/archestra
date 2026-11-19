import { DESKTOP_MCP_COPY } from "@/lib/mcp/desktop-mcp";

/** Why "Add to my computer" is not available for a desktop MCP item. */
export const DESKTOP_MCP_NO_TARGET_REASON =
  "This server isn't set up yet, so it can't be connected from your device.";

/**
 * Where the viewer stands with a desktop MCP catalog item:
 * - `unavailable`: no command and no URL, so Add is not offered;
 * - `not-installed`: Add is offered;
 * - `waiting`: added, waiting for the viewer's computer to run it;
 * - `installed`: the tools were read from the viewer's computer.
 *
 * Only the viewer's own installation counts: a desktop MCP server runs on
 * the computer of the user who added it, so another user's installation,
 * waiting or not, does not add it for the viewer.
 *
 * With no computer connected the server waits too, whatever was read from a
 * computer the viewer had before.
 */
export type DesktopMcpInstallState =
  | "unavailable"
  | "not-installed"
  | "waiting"
  /** The viewer linked it, but has no device with the MCP bridge. */
  | "no-device"
  /**
   * The installations, or the viewer's devices, are still being read: none
   * of the other states is known, so nothing is shown yet.
   */
  | "checking"
  | "installed";

type DesktopTarget = {
  command?: string | null;
  url?: string | null;
} | null;

type InstallRow = {
  catalogId?: string | null;
  ownerId?: string | null;
  scope?: string | null;
  teamId?: string | null;
  localInstallationStatus?: string | null;
};

/**
 * The viewer's state with a catalog item when it is a desktop MCP item; null
 * for every other item, whose install state the registry reads as before.
 */
export function desktopInstallStateOfRow(params: {
  item: {
    id: string;
    serverType: string;
    desktopConfig?: DesktopTarget;
  };
  servers: InstallRow[] | undefined;
  viewerId: string | null | undefined;
  /**
   * Whether the viewer has a device with the MCP bridge; "checking" while it
   * is read for the first time; undefined when it is not known (it could not
   * be read), which reads as the installation says.
   */
  hasComputer?: boolean | "checking";
}): DesktopMcpInstallState | null {
  const { item, servers, viewerId, hasComputer } = params;
  if (item.serverType !== "desktop_mcp") return null;
  // Not "not connected" before the installations are read: that would turn
  // into "Connected" a moment later.
  if (!servers) return "checking";
  const state = desktopMcpInstallState({
    catalogId: item.id,
    desktopConfig: item.desktopConfig,
    servers,
    viewerId,
  });
  // Connected, but no device runs it: the viewer unlinked their device, or
  // never set the MCP bridge up.
  if (state !== "installed" && state !== "waiting") return state;
  if (hasComputer === "checking") return "checking";
  return hasComputer === false ? "no-device" : state;
}

/**
 * The Add action a row or a card offers for a desktop MCP item: null when it
 * offers none. With no command and no URL the action shows, off, with the
 * reason. `installedForViewer` also holds while the page's installs load, so
 * no Add shows before the viewer's own installation is read.
 */
export function desktopAddAction(params: {
  state: DesktopMcpInstallState | null;
  installedForViewer: boolean;
}): { disabledReason: string | null } | null {
  const { state, installedForViewer } = params;
  if (installedForViewer) return null;
  if (state === "unavailable") {
    return { disabledReason: DESKTOP_MCP_NO_TARGET_REASON };
  }
  return state === "not-installed" ? { disabledReason: null } : null;
}

/** Whether the catalog item has a command or a URL for a computer to run. */
export function hasDesktopTarget(
  desktopConfig: DesktopTarget | undefined,
): boolean {
  return Boolean(desktopConfig?.command?.trim() || desktopConfig?.url?.trim());
}

/**
 * Whether the Add dialog starts with no screen of its own. It does when the
 * button that opened it said already what it does, but not for an item with
 * a command: the viewer first sees the command and can add arguments to it,
 * so the installation is not made before they press the button.
 */
export function desktopAddStartsAtOnce(params: {
  startAtOnce: boolean;
  /** The command of the catalog item; null when it has none. */
  command: string | null;
}): boolean {
  return params.startAtOnce && params.command === null;
}

/**
 * Whether the arguments in the field are other than the stored ones. No
 * arguments are stored as null.
 */
export function desktopArgumentsChanged(
  stored: readonly string[] | null | undefined,
  typed: readonly string[],
): boolean {
  const current = stored ?? [];
  return (
    current.length !== typed.length ||
    current.some((value, index) => value !== typed[index])
  );
}

/**
 * Which first screen the Add dialog shows, from the viewer's devices:
 * - `loading` / `error`: not known yet, so neither promise is made;
 * - `no-bridge`: no computer runs the MCP bridge, so Add leads to its setup;
 * - `bridge`: the MCP bridge on that computer gets the server right away.
 */
export type DesktopMcpAddCase<Device> =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "no-bridge" }
  | { kind: "bridge"; device: Device };

export function desktopMcpAddCase<Device>(devices: {
  data: Device[] | undefined;
  isPending: boolean;
  isError: boolean;
}): DesktopMcpAddCase<Device> {
  const device = devices.data?.[0];
  if (device) return { kind: "bridge", device };
  if (devices.isPending) return { kind: "loading" };
  if (devices.isError) return { kind: "error" };
  return { kind: "no-bridge" };
}

/**
 * The Link button of a desktop MCP server where it starts the link at once,
 * with no intro: it says whether the MCP bridge is set up first.
 */
export function desktopConnectActionLabel(
  addCase: DesktopMcpAddCase<unknown>,
): string {
  return addCase.kind === "no-bridge"
    ? DESKTOP_MCP_COPY.addWithBridge
    : DESKTOP_MCP_COPY.add;
}

/** The steps the Add dialog shows while the computer gets the server. */
export type DesktopMcpProgressStep = "sending" | "starting" | "reading";

export const DESKTOP_MCP_PROGRESS_STEPS: DesktopMcpProgressStep[] = [
  "sending",
  "starting",
  "reading",
];

/**
 * A calm note under the steps when the device is not getting there:
 * - `failed`: the MCP bridge reported that the server did not start;
 * - `slow`: it did not, but it takes longer than it should. A device that
 *   is offline gets no note of its own: it is often only between two polls
 *   right after it was linked.
 */
export type DesktopMcpProgressHint = "failed" | "slow";

export type DesktopMcpProgress =
  | { done: true }
  | {
      done: false;
      step: DesktopMcpProgressStep;
      hint: DesktopMcpProgressHint | null;
    };

/** After this long without the tools, the dialog says it takes long. */
export const DESKTOP_MCP_SLOW_AFTER_MS = 30_000;

/**
 * Where an Add stands, from what Archestra and the MCP bridge report:
 * - the installation status, `success` once the tools are read;
 * - the state the device reports for the server (null when it reported
 *   nothing for it yet);
 * - the time since Add, for the note that it takes long.
 *
 * The step only moves forward: once the MCP bridge reports the server
 * running, the step stays on reading its tools, also while Archestra waits
 * to read them again after a failed attempt.
 */
export function desktopMcpProgress(params: {
  installStatus: string | null | undefined;
  device: { serverState: string | null | undefined } | null;
  elapsedMs: number;
}): DesktopMcpProgress {
  const { installStatus, device, elapsedMs } = params;
  if (installStatus === "success") return { done: true };

  const serverState = device?.serverState ?? null;
  const step: DesktopMcpProgressStep =
    installStatus === "discovering-tools" || serverState === "running"
      ? "reading"
      : serverState === "starting" || serverState === "failed"
        ? "starting"
        : "sending";

  const hint: DesktopMcpProgressHint | null =
    serverState === "failed" || installStatus === "error"
      ? "failed"
      : elapsedMs >= DESKTOP_MCP_SLOW_AFTER_MS
        ? "slow"
        : null;

  return { done: false, step, hint };
}

/** The label of a step, with the server's name where it reads better. */
export function desktopMcpStepLabel(
  step: DesktopMcpProgressStep,
  name: string,
): string {
  switch (step) {
    case "sending":
      return "Checking your linked device";
    case "starting":
      return `Starting ${name}`;
    case "reading":
      return "Reading its tools";
  }
}

/** Whether a step is done, in progress or still to come. */
export function desktopMcpStepStatus(
  step: DesktopMcpProgressStep,
  current: DesktopMcpProgress,
): "done" | "current" | "upcoming" {
  if (current.done) return "done";
  const at = DESKTOP_MCP_PROGRESS_STEPS.indexOf(current.step);
  const index = DESKTOP_MCP_PROGRESS_STEPS.indexOf(step);
  if (index < at) return "done";
  return index === at ? "current" : "upcoming";
}

/**
 * The confirmation of Remove for a desktop MCP server: the MCP bridge stops
 * it on the computer of its user, the viewer's own or another user's.
 */
export function desktopRemoveCopy(params: { name: string; mine: boolean }): {
  title: string;
  description: string;
  confirm: string;
  confirming: string;
} {
  const { name, mine } = params;
  return mine
    ? {
        title: `Disconnect ${name} from your device?`,
        description: `The MCP bridge stops ${name} on your device, and agents lose its tools.`,
        confirm: DESKTOP_MCP_COPY.remove,
        confirming: DESKTOP_MCP_COPY.removing,
      }
    : {
        title: `Disconnect ${name} from their device?`,
        description: `The MCP bridge stops ${name} on their device, and their agents lose its tools.`,
        confirm: DESKTOP_MCP_COPY.removeTheirs,
        confirming: DESKTOP_MCP_COPY.removing,
      };
}

/**
 * What removing one selected installation means for the registry's bulk
 * action: a desktop MCP server on the viewer's own computer, one on another
 * user's computer, or (null) a server of another type, which is uninstalled.
 */
export type BulkRemoveKind = "mine" | "theirs" | null;

/** The kind of one selected installation, from the registry's issue index. */
export function bulkRemoveKindOf(params: {
  serverId: string;
  servers:
    | { id: string; catalogId: string; ownerId?: string | null }[]
    | undefined;
  catalogItems: { id: string; serverType: string }[] | undefined;
  viewerId: string | null | undefined;
}): BulkRemoveKind {
  const { serverId, servers, catalogItems, viewerId } = params;
  const server = servers?.find((candidate) => candidate.id === serverId);
  if (!server) return null;
  const item = catalogItems?.find(
    (candidate) => candidate.id === server.catalogId,
  );
  if (item?.serverType !== "desktop_mcp") return null;
  return viewerId && server.ownerId === viewerId ? "mine" : "theirs";
}

/**
 * The words of the registry's bulk action for a selection. Servers of other
 * types keep "Uninstall". A selection of desktop MCP servers alone speaks of
 * the computer they are removed from. A selection that mixes the two takes
 * the word both share: "Remove".
 */
export function bulkRemoveCopy(kinds: BulkRemoveKind[]): {
  /** The button of the selection bar. */
  action: string;
  /** Why the button is off when nothing in the selection can be removed. */
  noneReason: string;
  title: string;
  description: string;
  confirm: string;
  confirming: string;
  /** For the toast: "Removed 2 servers", "Failed to remove 1 server". */
  verb: string;
  failureVerb: string;
} {
  const count = kinds.length;
  const servers = `${count} ${count === 1 ? "server" : "servers"}`;
  const desktop = kinds.filter((kind) => kind !== null).length;
  if (desktop === 0) {
    return {
      action: "Uninstall",
      noneReason: "None of the selected servers are installed.",
      title: "Uninstall MCP servers",
      description: `Uninstall ${servers}? Agents using their tools lose access.`,
      confirm: "Uninstall servers",
      confirming: "Uninstalling...",
      verb: "Uninstalled",
      failureVerb: "uninstall",
    };
  }
  if (desktop < count) {
    return {
      action: "Remove",
      noneReason: "None of the selected servers can be removed.",
      title: "Remove MCP servers",
      description: `Remove ${servers}? Agents using their tools lose access.`,
      confirm: "Remove servers",
      confirming: DESKTOP_MCP_COPY.removing,
      verb: "Removed",
      failureVerb: "remove",
    };
  }
  const them = count === 1 ? "it" : "them";
  const their = count === 1 ? "its" : "their";
  if (kinds.every((kind) => kind === "mine")) {
    return {
      action: DESKTOP_MCP_COPY.remove,
      noneReason:
        "None of the selected servers are connected from your device.",
      title: `Disconnect ${servers} from your device?`,
      description: `The MCP bridge stops ${them} on your device, and agents lose ${their} tools.`,
      confirm: DESKTOP_MCP_COPY.remove,
      confirming: DESKTOP_MCP_COPY.removing,
      verb: "Removed",
      failureVerb: "remove",
    };
  }
  return {
    action: "Disconnect from devices",
    noneReason: "None of the selected servers are connected from a device.",
    title: `Disconnect ${servers} from devices?`,
    description: `The MCP bridge stops ${them} on the device of ${count === 1 ? "its user" : "each user"}, and agents lose ${their} tools.`,
    confirm: "Disconnect from devices",
    confirming: DESKTOP_MCP_COPY.removing,
    verb: "Removed",
    failureVerb: "remove",
  };
}

/**
 * One row of the Computers section: where the server stands on that user's
 * computer. Only the viewer's own computer has a name the app can read.
 */
export function desktopRowState(params: {
  isYou: boolean;
  ready: boolean;
  viewerDeviceName: string | null;
}): string {
  const { isYou, ready, viewerDeviceName } = params;
  const computer = isYou ? (viewerDeviceName ?? "your device") : "their device";
  return ready ? `On ${computer}` : `Waiting for ${computer}`;
}

/**
 * The Computers section for a viewer who sees only their own installation:
 * one line that says where the server stands on their computer, and the one
 * thing they can do about it. With no command and no URL there is nothing to
 * add, and no action.
 */
export function ownDesktopComputerLine(params: {
  name: string;
  /** The viewer's own installation; null when they have not added it. */
  installation: { ready: boolean } | null;
  /** Whether the catalog item has a command or a URL to run. */
  canAdd: boolean;
  viewerDeviceName: string | null;
  /**
   * Whether the viewer has a device; "checking" during the first read,
   * undefined when it could not be read.
   */
  hasComputer: boolean | "checking" | undefined;
}): { text: string; action: "add" | "remove" | null } {
  const { name, installation, canAdd, viewerDeviceName, hasComputer } = params;
  if (!installation) {
    return canAdd
      ? {
          text: `${name} is not connected from your device yet.`,
          action: "add",
        }
      : { text: DESKTOP_MCP_NO_TARGET_REASON, action: null };
  }
  return {
    text: desktopRowState({
      isYou: true,
      // Linked only once a device is known to run it: no "linked" that
      // turns into "not linked" a moment later.
      ready:
        installation.ready &&
        hasComputer !== false &&
        hasComputer !== "checking",
      viewerDeviceName,
    }),
    action: "remove",
  };
}

// ===

/** The viewer's own installation of the catalog item, if they have one. */
function viewerDesktopInstallation<T extends InstallRow>(params: {
  catalogId: string;
  servers: T[];
  viewerId: string | null | undefined;
}): T | undefined {
  const { catalogId, servers, viewerId } = params;
  if (!viewerId) return undefined;
  return servers.find(
    (server) =>
      server.catalogId === catalogId &&
      server.ownerId === viewerId &&
      (server.scope === "personal" || (!server.scope && !server.teamId)),
  );
}

function desktopMcpInstallState(params: {
  catalogId: string;
  desktopConfig: DesktopTarget | undefined;
  servers: InstallRow[];
  viewerId: string | null | undefined;
}): DesktopMcpInstallState {
  const own = viewerDesktopInstallation(params);
  if (own) {
    return own.localInstallationStatus === "success" ? "installed" : "waiting";
  }
  return hasDesktopTarget(params.desktopConfig)
    ? "not-installed"
    : "unavailable";
}
