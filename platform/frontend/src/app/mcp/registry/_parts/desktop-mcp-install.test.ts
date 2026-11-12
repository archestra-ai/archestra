// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  bulkRemoveCopy,
  bulkRemoveKindOf,
  DESKTOP_MCP_NO_TARGET_REASON,
  DESKTOP_MCP_SLOW_AFTER_MS,
  desktopAddAction,
  desktopInstallStateOfRow,
  desktopMcpAddCase,
  desktopMcpProgress,
  desktopMcpStepLabel,
  desktopMcpStepStatus,
  desktopRemoveCopy,
  desktopRowState,
  hasDesktopTarget,
  ownDesktopComputerLine,
} from "./desktop-mcp-install";

const CATALOG_ID = "7c1e0000-0000-4000-8000-000000000a94";
const VIEWER = "user-viewer";
const COLLEAGUE = "user-colleague";
const COMMAND = { command: "/opt/matlab/mcp", url: null };

function desktopMcpInstallState(params: {
  catalogId: string;
  desktopConfig: { command: string | null; url: string | null };
  servers: ReturnType<typeof installation>[];
  viewerId: string;
}) {
  return desktopInstallStateOfRow({
    item: {
      id: params.catalogId,
      serverType: "desktop_mcp",
      desktopConfig: params.desktopConfig,
    },
    servers: params.servers,
    viewerId: params.viewerId,
  });
}

function installation(ownerId: string, localInstallationStatus: string) {
  return {
    catalogId: CATALOG_ID,
    ownerId,
    scope: "personal",
    teamId: null,
    localInstallationStatus,
  };
}

describe("desktopInstallStateOfRow for a desktop MCP item", () => {
  it("offers Add while only a colleague has an installation, even a waiting one", () => {
    expect(
      desktopMcpInstallState({
        catalogId: CATALOG_ID,
        desktopConfig: COMMAND,
        servers: [installation(COLLEAGUE, "pending")],
        viewerId: VIEWER,
      }),
    ).toBe("not-installed");
  });

  it("waits for the viewer's computer until their installation has its tools", () => {
    for (const status of ["pending", "discovering-tools", "idle"]) {
      expect(
        desktopMcpInstallState({
          catalogId: CATALOG_ID,
          desktopConfig: COMMAND,
          servers: [
            installation(COLLEAGUE, "success"),
            installation(VIEWER, status),
          ],
          viewerId: VIEWER,
        }),
      ).toBe("waiting");
    }
  });

  it("is installed once the viewer's installation has its tools", () => {
    expect(
      desktopMcpInstallState({
        catalogId: CATALOG_ID,
        desktopConfig: COMMAND,
        servers: [installation(VIEWER, "success")],
        viewerId: VIEWER,
      }),
    ).toBe("installed");
  });

  it("offers no Add for an item with no command and no URL, but keeps an existing installation", () => {
    const empty = { command: "  ", url: null };

    expect(
      desktopMcpInstallState({
        catalogId: CATALOG_ID,
        desktopConfig: empty,
        servers: [],
        viewerId: VIEWER,
      }),
    ).toBe("unavailable");
    // An admin cleared the command after the viewer installed it: the viewer
    // still has the installation, and its Remove from my computer.
    expect(
      desktopMcpInstallState({
        catalogId: CATALOG_ID,
        desktopConfig: empty,
        servers: [installation(VIEWER, "success")],
        viewerId: VIEWER,
      }),
    ).toBe("installed");
  });

  it("does not count the viewer's installation of another catalog item", () => {
    expect(
      desktopMcpInstallState({
        catalogId: CATALOG_ID,
        desktopConfig: COMMAND,
        servers: [
          { ...installation(VIEWER, "success"), catalogId: "another-item" },
        ],
        viewerId: VIEWER,
      }),
    ).toBe("not-installed");
  });
});

describe("desktopInstallStateOfRow with no computer connected", () => {
  const stateWith = (status: string, hasComputer: boolean | undefined) =>
    desktopInstallStateOfRow({
      item: {
        id: CATALOG_ID,
        serverType: "desktop_mcp",
        desktopConfig: COMMAND,
      },
      servers: [installation(VIEWER, status)],
      viewerId: VIEWER,
      hasComputer,
    });

  it("waits for the computer, even when the tools were read from one before", () => {
    expect(stateWith("success", false)).toBe("waiting");
    expect(stateWith("pending", false)).toBe("waiting");
  });

  it("reads as the installation says with a computer, and while that is not known", () => {
    expect(stateWith("success", true)).toBe("installed");
    expect(stateWith("success", undefined)).toBe("installed");
  });

  it("still offers Add for a server the viewer has not added", () => {
    expect(
      desktopInstallStateOfRow({
        item: {
          id: CATALOG_ID,
          serverType: "desktop_mcp",
          desktopConfig: COMMAND,
        },
        servers: [],
        viewerId: VIEWER,
        hasComputer: false,
      }),
    ).toBe("not-installed");
  });
});

describe("bulkRemoveKindOf", () => {
  const index = {
    servers: [
      { id: "s-mine", catalogId: CATALOG_ID, ownerId: VIEWER },
      { id: "s-theirs", catalogId: CATALOG_ID, ownerId: COLLEAGUE },
      { id: "s-remote", catalogId: "catalog-remote", ownerId: VIEWER },
    ],
    catalogItems: [
      { id: CATALOG_ID, serverType: "desktop_mcp" },
      { id: "catalog-remote", serverType: "remote" },
    ],
  };
  const kind = (serverId: string) =>
    bulkRemoveKindOf({ serverId, ...index, viewerId: VIEWER });

  it("tells the viewer's computer from another user's", () => {
    expect(kind("s-mine")).toBe("mine");
    expect(kind("s-theirs")).toBe("theirs");
  });

  it("is null for a server of another type, and for one it does not know", () => {
    expect(kind("s-remote")).toBeNull();
    expect(kind("s-unknown")).toBeNull();
    expect(
      bulkRemoveKindOf({
        serverId: "s-mine",
        servers: undefined,
        catalogItems: undefined,
        viewerId: VIEWER,
      }),
    ).toBeNull();
  });
});

describe("bulkRemoveCopy", () => {
  it("keeps Uninstall for a selection with no desktop MCP server", () => {
    expect(bulkRemoveCopy([null, null])).toEqual({
      action: "Uninstall",
      noneReason: "None of the selected servers are installed.",
      title: "Uninstall MCP servers",
      description: "Uninstall 2 servers? Agents using their tools lose access.",
      confirm: "Uninstall servers",
      confirming: "Uninstalling...",
      verb: "Uninstalled",
      failureVerb: "uninstall",
    });
    expect(bulkRemoveCopy([]).action).toBe("Uninstall");
  });

  it("speaks of the viewer's computer when every server is on it", () => {
    const copy = bulkRemoveCopy(["mine", "mine"]);
    expect(copy.action).toBe("Unlink from my device");
    expect(copy.title).toBe("Unlink 2 servers from your device?");
    expect(copy.description).toBe(
      "The MCP bridge stops them on your device, and agents lose their tools.",
    );
    expect(copy.confirm).toBe("Unlink from my device");
    expect(copy.verb).toBe("Removed");
    expect(bulkRemoveCopy(["mine"]).description).toBe(
      "The MCP bridge stops it on your device, and agents lose its tools.",
    );
  });

  it('does not say "my computer" when one is on another user\'s computer', () => {
    const copy = bulkRemoveCopy(["mine", "theirs"]);
    expect(copy.action).toBe("Unlink from devices");
    expect(copy.title).toBe("Unlink 2 servers from devices?");
    expect(copy.description).toContain("on the device of each user");
  });

  it("takes the neutral word for desktop and other servers together", () => {
    const copy = bulkRemoveCopy(["mine", null, null]);
    expect(copy.action).toBe("Remove");
    expect(copy.title).toBe("Remove MCP servers");
    expect(copy.description).toBe(
      "Remove 3 servers? Agents using their tools lose access.",
    );
    expect(copy.confirm).toBe("Remove servers");
    expect(copy.failureVerb).toBe("remove");
    for (const text of Object.values(copy)) {
      expect(text).not.toMatch(/install/i);
    }
  });
});

describe("desktopInstallStateOfRow for other items", () => {
  it("leaves every item that is not a desktop MCP server to the other rules", () => {
    expect(
      desktopInstallStateOfRow({
        item: { id: CATALOG_ID, serverType: "remote" },
        servers: [installation(VIEWER, "pending")],
        viewerId: VIEWER,
      }),
    ).toBeNull();
  });
});

describe("desktopAddAction", () => {
  it("offers Add only while the viewer has not added the server", () => {
    const offered = (state: Parameters<typeof desktopAddAction>[0]["state"]) =>
      desktopAddAction({ state, installedForViewer: false });
    expect(offered("not-installed")).toEqual({ disabledReason: null });
    expect(offered("waiting")).toBeNull();
    expect(offered("installed")).toBeNull();
    expect(offered(null)).toBeNull();
  });

  it("shows Add off, with the reason, for an item with no command and no URL", () => {
    expect(
      desktopAddAction({ state: "unavailable", installedForViewer: false }),
    ).toEqual({ disabledReason: DESKTOP_MCP_NO_TARGET_REASON });
  });

  it("offers nothing while the page's installs load", () => {
    // The state is read from installs that are not there yet.
    expect(
      desktopAddAction({ state: "not-installed", installedForViewer: true }),
    ).toBeNull();
  });
});

describe("hasDesktopTarget", () => {
  it("holds for a command or a URL, not for blanks", () => {
    expect(hasDesktopTarget(COMMAND)).toBe(true);
    expect(
      hasDesktopTarget({ command: null, url: "http://127.0.0.1:8080/mcp" }),
    ).toBe(true);
    expect(hasDesktopTarget({ command: "", url: " " })).toBe(false);
    expect(hasDesktopTarget(null)).toBe(false);
  });
});

describe("desktopMcpAddCase", () => {
  const device = { id: "device-1", name: "laptop-0142" };

  it("adds through the MCP bridge on the viewer's computer", () => {
    expect(
      desktopMcpAddCase({ data: [device], isPending: false, isError: false }),
    ).toEqual({ kind: "bridge", device });
  });

  it("leads to the MCP bridge setup when the viewer has no computer", () => {
    expect(
      desktopMcpAddCase({ data: [], isPending: false, isError: false }),
    ).toEqual({ kind: "no-bridge" });
  });

  it("promises neither while the devices load or cannot be read", () => {
    expect(
      desktopMcpAddCase({ data: undefined, isPending: true, isError: false }),
    ).toEqual({ kind: "loading" });
    expect(
      desktopMcpAddCase({ data: undefined, isPending: false, isError: true }),
    ).toEqual({ kind: "error" });
  });

  it("keeps the computer it knows when a later read fails", () => {
    expect(
      desktopMcpAddCase({ data: [device], isPending: false, isError: true }),
    ).toEqual({ kind: "bridge", device });
  });
});

describe("desktopMcpProgress", () => {
  const online = (serverState: string | null) => ({
    online: true,
    serverState,
  });

  it("sends to the computer until the MCP bridge reports the server", () => {
    for (const serverState of [null, "stopped", "no_command"]) {
      expect(
        desktopMcpProgress({
          installStatus: "pending",
          device: online(serverState),
          elapsedMs: 1_000,
        }),
      ).toEqual({ done: false, step: "sending", hint: null });
    }
  });

  it("starts the server, then reads its tools, then is done", () => {
    expect(
      desktopMcpProgress({
        installStatus: "pending",
        device: online("starting"),
        elapsedMs: 1_000,
      }),
    ).toEqual({ done: false, step: "starting", hint: null });
    expect(
      desktopMcpProgress({
        installStatus: "discovering-tools",
        device: online("starting"),
        elapsedMs: 1_000,
      }),
    ).toEqual({ done: false, step: "reading", hint: null });
    expect(
      desktopMcpProgress({
        installStatus: "success",
        device: online("running"),
        elapsedMs: 1_000,
      }),
    ).toEqual({ done: true });
  });

  it("stays on reading the tools while a failed read waits to be tried again", () => {
    // The backend sets the installation back to pending after a failed
    // tools/list; the server still runs.
    expect(
      desktopMcpProgress({
        installStatus: "pending",
        device: online("running"),
        elapsedMs: 5_000,
      }),
    ).toEqual({ done: false, step: "reading", hint: null });
  });

  it("says the computer is offline before anything else", () => {
    expect(
      desktopMcpProgress({
        installStatus: "pending",
        device: { online: false, serverState: null },
        elapsedMs: DESKTOP_MCP_SLOW_AFTER_MS * 2,
      }),
    ).toEqual({ done: false, step: "sending", hint: "offline" });
  });

  it("says the server did not start when the MCP bridge reports a failure", () => {
    expect(
      desktopMcpProgress({
        installStatus: "pending",
        device: online("failed"),
        elapsedMs: 1_000,
      }),
    ).toEqual({ done: false, step: "starting", hint: "failed" });
  });

  it("says it takes long only after the slow mark", () => {
    const at = (elapsedMs: number) =>
      desktopMcpProgress({
        installStatus: "pending",
        device: online("starting"),
        elapsedMs,
      });
    expect(at(DESKTOP_MCP_SLOW_AFTER_MS - 1)).toMatchObject({ hint: null });
    expect(at(DESKTOP_MCP_SLOW_AFTER_MS)).toMatchObject({ hint: "slow" });
  });

  it("follows the installation alone when no computer is known", () => {
    expect(
      desktopMcpProgress({
        installStatus: "pending",
        device: null,
        elapsedMs: 1_000,
      }),
    ).toEqual({ done: false, step: "sending", hint: null });
    expect(
      desktopMcpProgress({
        installStatus: "success",
        device: null,
        elapsedMs: 1_000,
      }),
    ).toEqual({ done: true });
  });
});

describe("desktopMcpStepStatus and desktopMcpStepLabel", () => {
  it("marks the steps before the current one done and the rest to come", () => {
    const progress = {
      done: false as const,
      step: "starting" as const,
      hint: null,
    };
    expect(desktopMcpStepStatus("sending", progress)).toBe("done");
    expect(desktopMcpStepStatus("starting", progress)).toBe("current");
    expect(desktopMcpStepStatus("reading", progress)).toBe("upcoming");
    expect(desktopMcpStepStatus("reading", { done: true })).toBe("done");
  });

  it("names the server where it reads better", () => {
    expect(desktopMcpStepLabel("sending", "MATLAB")).toBe(
      "Sending to your device",
    );
    expect(desktopMcpStepLabel("starting", "MATLAB")).toBe("Starting MATLAB");
    expect(desktopMcpStepLabel("reading", "MATLAB")).toBe("Reading its tools");
  });
});

describe("desktopRowState", () => {
  it("names the viewer's computer, and only theirs", () => {
    expect(
      desktopRowState({
        isYou: true,
        ready: true,
        viewerDeviceName: "laptop-0142",
      }),
    ).toBe("On laptop-0142");
    expect(
      desktopRowState({ isYou: true, ready: false, viewerDeviceName: null }),
    ).toBe("Waiting for your device");
    expect(
      desktopRowState({
        isYou: false,
        ready: true,
        viewerDeviceName: "laptop-0142",
      }),
    ).toBe("On their device");
    expect(
      desktopRowState({ isYou: false, ready: false, viewerDeviceName: null }),
    ).toBe("Waiting for their device");
  });
});

describe("ownDesktopComputerLine", () => {
  const line = (
    params: Partial<Parameters<typeof ownDesktopComputerLine>[0]>,
  ) =>
    ownDesktopComputerLine({
      name: "MATLAB",
      installation: null,
      canAdd: true,
      viewerDeviceName: "Ada-MacBook",
      hasComputer: true,
      ...params,
    });

  it("offers Add while the viewer has not added the server, whoever else has", () => {
    expect(line({})).toEqual({
      text: "MATLAB is not linked to your device yet.",
      action: "add",
    });
  });

  it("offers nothing for a server with no command and no URL", () => {
    expect(line({ canAdd: false })).toEqual({
      text: "This server isn't set up yet, so it can't be linked to your device.",
      action: null,
    });
  });

  it("names the computer the server waits for, then the one it is on", () => {
    expect(line({ installation: { ready: false } })).toEqual({
      text: "Waiting for Ada-MacBook",
      action: "remove",
    });
    expect(line({ installation: { ready: true } })).toEqual({
      text: "On Ada-MacBook",
      action: "remove",
    });
  });

  it("waits for a computer when none is connected, whatever was read before", () => {
    expect(
      line({
        installation: { ready: true },
        viewerDeviceName: null,
        hasComputer: false,
      }),
    ).toEqual({ text: "Waiting for your device", action: "remove" });
  });

  it("reads as the installation says while the computer is not known", () => {
    expect(
      line({
        installation: { ready: true },
        viewerDeviceName: null,
        hasComputer: undefined,
      }).text,
    ).toBe("On your device");
  });
});

describe("desktopRemoveCopy", () => {
  it("says the MCP bridge stops it on the viewer's computer, with no team or organization", () => {
    const copy = desktopRemoveCopy({ name: "MATLAB", mine: true });
    expect(copy).toEqual({
      title: "Unlink MATLAB from your device?",
      description:
        "The MCP bridge stops MATLAB on your device, and agents lose its tools.",
      confirm: "Unlink from my device",
      confirming: "Unlinking...",
    });
    expect(JSON.stringify(copy)).not.toMatch(/team|organization|install/i);
  });

  it("speaks of their computer when the row is another user's", () => {
    expect(desktopRemoveCopy({ name: "MATLAB", mine: false })).toMatchObject({
      title: "Unlink MATLAB from their device?",
      confirm: "Unlink from their device",
    });
  });
});
