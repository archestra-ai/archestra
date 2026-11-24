import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  devicePlatformLabel,
  deviceProgramUpdateNotice,
  deviceProgramVersionLabel,
  deviceServerRows,
  deviceServersLabel,
  deviceStatusLabel,
} from "./device-labels";

describe("deviceStatusLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives no time for a device that is online", () => {
    expect(
      deviceStatusLabel({
        online: true,
        lastPolledAt: "2026-11-12T11:59:58Z",
      }),
    ).toEqual({ status: "Online", lastOnline: null });
  });

  it("says when an offline device was last online", () => {
    expect(
      deviceStatusLabel({
        online: false,
        lastPolledAt: "2026-11-12T09:00:00Z",
      }),
    ).toEqual({ status: "Offline", lastOnline: "Last online 3 hours ago" });
  });

  it("gives no time for a device that was never online", () => {
    expect(deviceStatusLabel({ online: false, lastPolledAt: null })).toEqual({
      status: "Offline",
      lastOnline: null,
    });
  });
});

describe("devicePlatformLabel", () => {
  it("names each system that the MCP bridge runs on", () => {
    expect(devicePlatformLabel("macos")).toBe("macOS");
    expect(devicePlatformLabel("windows")).toBe("Windows");
    expect(devicePlatformLabel("linux")).toBe("Linux");
  });
});

describe("deviceProgramVersionLabel", () => {
  it("shows the version the MCP bridge reported", () => {
    expect(deviceProgramVersionLabel("0.2.0")).toBe("0.2.0");
  });

  it("says so when the MCP bridge reported no version", () => {
    expect(deviceProgramVersionLabel(null)).toBe("Not reported");
  });
});

describe("deviceProgramUpdateNotice", () => {
  const notice = (
    device: Partial<Parameters<typeof deviceProgramUpdateNotice>[0]>,
  ) =>
    deviceProgramUpdateNotice({
      platform: "linux",
      programUpdate: { version: "0.2.0" },
      programAutoUpdate: true,
      ...device,
    });
  const sentence = (device: Parameters<typeof notice>[0]) => {
    const text = notice(device)?.text;
    return text && `${text.before}${text.command}${text.after}`;
  };

  it("shows nothing for a device with no update", () => {
    expect(notice({ programUpdate: null })).toBeNull();
  });

  it("names the new version when it is known", () => {
    expect(notice({})?.title).toBe(
      "A new version of the MCP bridge (0.2.0) is available",
    );
    expect(notice({ programUpdate: { version: null } })?.title).toBe(
      "A new version of the MCP bridge is available",
    );
  });

  it("says that a Windows device updates by itself, and how to update now", () => {
    const text =
      "The device updates by itself when no tool call is running. To update now, run archestra update in a terminal on that device.";
    expect(sentence({ platform: "windows" })).toBe(text);
  });

  it("tells a macOS or Linux user to run the command", () => {
    expect(sentence({ platform: "macos" })).toBe(
      "Run archestra update in a terminal on that device.",
    );
    expect(sentence({ platform: "linux" })).toBe(
      "Run archestra update in a terminal on that device.",
    );
  });

  it("tells every user to run the command when auto-update is off", () => {
    expect(sentence({ platform: "windows", programAutoUpdate: false })).toBe(
      "Run archestra update in a terminal on that device.",
    );
  });

  it("gives the command apart from the words around it", () => {
    expect(notice({ platform: "macos" })?.text).toEqual({
      before: "Run ",
      command: "archestra update",
      after: " in a terminal on that device.",
    });
  });
});

type Server = Parameters<typeof deviceServerRows>[0][number];

function server(overrides: Partial<Server>): Server {
  return {
    catalogId: "catalog-1",
    name: "Filesystem",
    icon: null,
    iconUrl: null,
    state: "running",
    lastError: null,
    command: "npx -y @modelcontextprotocol/server-filesystem",
    url: null,
    enabled: true,
    toolCount: 14,
    ...overrides,
  };
}

describe("deviceServersLabel", () => {
  it("counts the running servers, and shows no failed count when none failed", () => {
    expect(
      deviceServersLabel({
        online: true,
        servers: [
          server({ catalogId: "a" }),
          server({ catalogId: "b" }),
          server({ catalogId: "c", state: "starting" }),
        ],
      }),
    ).toEqual({ running: "2 running", failed: null });
  });

  it("adds the failed count when a server failed", () => {
    expect(
      deviceServersLabel({
        online: true,
        servers: [
          server({ catalogId: "a" }),
          server({ catalogId: "b", state: "failed" }),
        ],
      }),
    ).toEqual({ running: "1 running", failed: "1 failed" });
  });

  it("knows nothing for an offline device", () => {
    expect(
      deviceServersLabel({ online: false, servers: [server({})] }),
    ).toBeNull();
  });
});

describe("deviceServerRows", () => {
  it("lists failed servers first, the others in their order", () => {
    const rows = deviceServerRows([
      server({ catalogId: "a", name: "Chrome DevTools" }),
      server({ catalogId: "b", name: "Blender", state: "failed" }),
      server({ catalogId: "c", name: "Playwright", state: "starting" }),
    ]);
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ["Blender", "Failed"],
      ["Chrome DevTools", "Running"],
      ["Playwright", "Starting"],
    ]);
  });

  it("gives the image of a server before its emoji, and nothing with none", () => {
    const rows = deviceServerRows([
      server({ catalogId: "a", icon: "🧩" }),
      server({
        catalogId: "b",
        iconUrl: "/api/internal_mcp_catalog/b/icon?v=1",
      }),
      server({ catalogId: "c" }),
    ]);
    expect(rows.map((row) => row.icon)).toEqual([
      "🧩",
      "/api/internal_mcp_catalog/b/icon?v=1",
      null,
    ]);
  });

  it("words a known error as one plain sentence", () => {
    const [row] = deviceServerRows([
      server({
        name: "Blender",
        state: "failed",
        command: "uvx blender-mcp",
        lastError:
          "cannot start the program: No such file or directory (os error 2)",
      }),
    ]);
    expect(row.error).toBe('The program "uvx" was not found on this device.');
  });

  it("shows an unknown error as it came", () => {
    const [row] = deviceServerRows([
      server({ state: "failed", lastError: "something else went wrong" }),
    ]);
    expect(row.error).toBe("something else went wrong");
  });

  it("gives a running server no error", () => {
    const [row] = deviceServerRows([
      server({ lastError: "an old error from before it ran" }),
    ]);
    expect(row.error).toBeNull();
    expect(row.running).toBe(true);
  });
});
