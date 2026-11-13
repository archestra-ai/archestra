import { describe, expect, it, vi } from "vitest";
import {
  addDesktopMcpServer,
  desktopHostingOffered,
  desktopMcpTargetError,
  desktopMcpTargetOf,
  desktopMcpTargetToApi,
  desktopServerErrorSentence,
  desktopServerStartLabel,
  ownDesktopMcpServers,
} from "./desktop-mcp";

describe("addDesktopMcpServer", () => {
  const catalogItem = { id: "catalog-matlab", name: "MATLAB" };

  it("asks for a personal installation and resolves with it", async () => {
    const server = { id: "server-1" };
    const install = vi.fn(async () => ({
      installedServer: server,
      errorMessage: null,
    }));

    await expect(addDesktopMcpServer({ install, catalogItem })).resolves.toBe(
      server,
    );
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "MATLAB",
        catalogId: "catalog-matlab",
        scope: "personal",
      }),
    );
  });

  it("resolves with null when the installation was refused", async () => {
    const install = async () => ({
      installedServer: undefined,
      errorMessage: "A desktop MCP server needs a command or a URL",
    });

    await expect(
      addDesktopMcpServer({ install, catalogItem }),
    ).resolves.toBeNull();
  });
});

describe("desktopMcpTargetOf", () => {
  it("reads a command", () => {
    expect(
      desktopMcpTargetOf({ command: "/opt/mcp serve", url: null }),
    ).toEqual({ kind: "command", value: "/opt/mcp serve" });
  });

  it("reads a URL", () => {
    expect(
      desktopMcpTargetOf({ command: null, url: "http://127.0.0.1:8080/mcp" }),
    ).toEqual({ kind: "url", value: "http://127.0.0.1:8080/mcp" });
  });

  it("starts as an empty command when neither is set", () => {
    expect(desktopMcpTargetOf({})).toEqual({ kind: "command", value: "" });
    expect(desktopMcpTargetOf({ command: null, url: null })).toEqual({
      kind: "command",
      value: "",
    });
  });
});

describe("desktopMcpTargetToApi", () => {
  it("sends the command and no URL", () => {
    expect(
      desktopMcpTargetToApi({ kind: "command", value: " /opt/mcp serve " }),
    ).toEqual({ command: "/opt/mcp serve", url: null });
  });

  it("sends the URL and no command", () => {
    expect(
      desktopMcpTargetToApi({
        kind: "url",
        value: "http://127.0.0.1:8080/mcp",
      }),
    ).toEqual({ command: null, url: "http://127.0.0.1:8080/mcp" });
  });

  it("sends null for both when the value is empty", () => {
    expect(desktopMcpTargetToApi({ kind: "command", value: "  " })).toEqual({
      command: null,
      url: null,
    });
    expect(desktopMcpTargetToApi({ kind: "url", value: "" })).toEqual({
      command: null,
      url: null,
    });
  });
});

describe("desktopMcpTargetError", () => {
  it("accepts an empty value", () => {
    expect(desktopMcpTargetError({ kind: "command", value: "" })).toBeNull();
    expect(desktopMcpTargetError({ kind: "url", value: "   " })).toBeNull();
  });

  it("accepts a command with the two variables", () => {
    expect(
      desktopMcpTargetError({
        kind: "command",
        value: "/Users/$USER/bins/mcp --home $HOME",
      }),
    ).toBeNull();
  });

  it("accepts an http and an https URL", () => {
    expect(
      desktopMcpTargetError({
        kind: "url",
        value: "http://127.0.0.1:8080/mcp",
      }),
    ).toBeNull();
    expect(
      desktopMcpTargetError({ kind: "url", value: "https://localhost/mcp" }),
    ).toBeNull();
  });

  it("rejects a URL that is not http(s)", () => {
    expect(
      desktopMcpTargetError({ kind: "url", value: "127.0.0.1:8080/mcp" }),
    ).toBe("The URL must start with http:// or https://");
    expect(
      desktopMcpTargetError({ kind: "url", value: "file:///tmp/mcp.sock" }),
    ).toBe("The URL must start with http:// or https://");
  });

  it("rejects a value longer than the backend stores", () => {
    expect(
      desktopMcpTargetError({ kind: "command", value: "a".repeat(4097) }),
    ).toBe("Use at most 4096 characters.");
    expect(
      desktopMcpTargetError({ kind: "command", value: "a".repeat(4096) }),
    ).toBeNull();
  });
});

describe("ownDesktopMcpServers", () => {
  const VIEWER = "user-viewer";
  const catalogItems = [
    { id: "matlab", name: "MATLAB", serverType: "desktop_mcp", icon: null },
    {
      id: "notes",
      name: "Notes",
      serverType: "desktop_mcp",
      icon: "notes.png",
      iconUrl: "/icons/notes.png",
    },
    { id: "github", name: "GitHub", serverType: "remote", icon: null },
  ];
  const install = (
    catalogId: string,
    ownerId: string,
    localInstallationStatus: string,
    scope = "personal",
  ) => ({ catalogId, ownerId, scope, localInstallationStatus });

  it("lists the viewer's own desktop installations, by name, ready or waiting", () => {
    expect(
      ownDesktopMcpServers({
        catalogItems,
        servers: [
          install("notes", VIEWER, "success"),
          install("matlab", VIEWER, "pending"),
          install("matlab", "user-colleague", "success"),
          install("github", VIEWER, "success"),
          install("notes", VIEWER, "success", "team"),
        ],
        viewerId: VIEWER,
      }),
    ).toEqual([
      { catalogId: "matlab", name: "MATLAB", icon: null, ready: false },
      {
        catalogId: "notes",
        name: "Notes",
        icon: "/icons/notes.png",
        ready: true,
      },
    ]);
  });

  it("lists nothing without a viewer or data", () => {
    expect(
      ownDesktopMcpServers({
        catalogItems,
        servers: [install("matlab", VIEWER, "success")],
        viewerId: null,
      }),
    ).toEqual([]);
    expect(
      ownDesktopMcpServers({
        catalogItems: undefined,
        servers: undefined,
        viewerId: VIEWER,
      }),
    ).toEqual([]);
  });
});

describe("desktopServerStartLabel", () => {
  it("names each state the MCP bridge reports", () => {
    for (const [state, label] of [
      ["running", "Running"],
      ["starting", "Starting"],
      ["failed", "Failed"],
      ["stopped", "Stopped"],
      ["no_command", "No command"],
    ]) {
      expect(desktopServerStartLabel(state)).toBe(label);
    }
  });

  it("says a server the MCP bridge did not report yet is about to start", () => {
    expect(desktopServerStartLabel(null)).toBe("Starting");
    expect(desktopServerStartLabel(undefined)).toBe("Starting");
    expect(desktopServerStartLabel("something-new")).toBe("Starting");
  });
});

describe("desktopServerErrorSentence", () => {
  const sentence = (
    error: string | null,
    target: { command?: string | null; url?: string | null } = {},
  ) => desktopServerErrorSentence({ error, name: "MATLAB", ...target });

  it("says nothing when there is no error", () => {
    expect(sentence(null)).toBeNull();
    expect(sentence("  ")).toBeNull();
  });

  it("names the program that was not found", () => {
    expect(
      sentence(
        "cannot start the program: No such file or directory (os error 2)",
        { command: "eda-agent --stdio" },
      ),
    ).toBe('The program "eda-agent" was not found on this device.');
  });

  it("reads what Windows says for a program that was not found", () => {
    for (const error of [
      "cannot start the program: program not found",
      "cannot start the program: The system cannot find the file specified. (os error 2)",
      "cannot start the program: The system cannot find the path specified. (os error 3)",
    ]) {
      expect(sentence(error, { command: "matlab-mcp.exe" })).toBe(
        'The program "matlab-mcp.exe" was not found on this device.',
      );
    }
  });

  it("takes the program from a quoted path with spaces", () => {
    expect(
      sentence(
        "cannot start the program: No such file or directory (os error 2)",
        { command: '"/Applications/My Tools/mcp" --port 1' },
      ),
    ).toBe(
      'The program "/Applications/My Tools/mcp" was not found on this device.',
    );
  });

  it("names a program the computer does not let run", () => {
    expect(
      sentence("cannot start the program: Permission denied (os error 13)", {
        command: "/opt/router/mcp",
      }),
    ).toBe(
      'The program "/opt/router/mcp" is not allowed to run on this device.',
    );
    expect(
      sentence("cannot start the program: Access is denied. (os error 5)", {
        command: "router.exe",
      }),
    ).toBe('The program "router.exe" is not allowed to run on this device.');
  });

  it("keeps a sentence for any other reason a program did not start, also with no command known", () => {
    expect(
      sentence("cannot start the program: Exec format error (os error 8)", {
        command: "mcp",
      }),
    ).toBe('The program "mcp" could not start on this device.');
    expect(
      sentence(
        "cannot start the program: No such file or directory (os error 2)",
      ),
    ).toBe("The program was not found on this device.");
  });

  it("words what the server did after it started", () => {
    expect(
      sentence("the MCP server closed before it answered `initialize`"),
    ).toBe("MATLAB closed right after it started.");
    expect(sentence("the MCP server did not answer `initialize` in time")).toBe(
      "MATLAB started, but did not answer in time.",
    );
    expect(
      sentence(
        'the MCP server answered `initialize` with an error: {"code":-32600}',
      ),
    ).toBe("MATLAB started, but answered with an error.");
    expect(sentence("the MCP server stopped (exit status: 3)")).toBe(
      "MATLAB stopped by itself.",
    );
  });

  it("names the URL where nothing answers", () => {
    expect(
      sentence(
        "the request failed: error sending request: tcp connect error: Connection refused (os error 61)",
        { url: "http://127.0.0.1:8080/mcp" },
      ),
    ).toBe("Nothing answers at http://127.0.0.1:8080/mcp on this device.");
  });

  it("returns an error it does not know as it came", () => {
    expect(sentence("the program has no stdin or stdout pipe")).toBe(
      "the program has no stdin or stdout pipe",
    );
  });
});

describe("desktopHostingOffered", () => {
  it("offers Desktop hosting only with the beta flag, as it is in alpha", () => {
    expect(
      desktopHostingOffered({ betaEnabled: true, current: "remote" }),
    ).toBe(true);
    expect(
      desktopHostingOffered({ betaEnabled: false, current: "remote" }),
    ).toBe(false);
    expect(
      desktopHostingOffered({ betaEnabled: false, current: undefined }),
    ).toBe(false);
  });

  it("keeps Desktop for an item that already is one", () => {
    expect(
      desktopHostingOffered({ betaEnabled: false, current: "desktop_mcp" }),
    ).toBe(true);
  });
});
