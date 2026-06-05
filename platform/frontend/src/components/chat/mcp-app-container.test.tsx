import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock heavy dependencies before module import ─────────────────────────────

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
  ) {
    this.onrequestdisplaymode = null;
    this.onopenlink = null;
    this.oncalltool = null;
    this.onreadresource = null;
    this.onlistresources = null;
    this.onlistresourcetemplates = null;
    this.onlistprompts = null;
    this.onloggingmessage = null;
    this.onmessage = null;
    this.onsizechange = null;
    this.oninitialized = null;
    this.onsandboxready = null;
    this.connect = vi.fn().mockReturnValue(Promise.resolve());
    this.sendSandboxResourceReady = vi.fn().mockReturnValue(Promise.resolve());
    this.sendToolInput = vi.fn().mockReturnValue(Promise.resolve());
    this.sendToolInputPartial = vi.fn().mockReturnValue(Promise.resolve());
    this.sendToolResult = vi.fn().mockReturnValue(Promise.resolve());
    this.setHostContext = vi.fn();
    this.teardownResource = vi.fn().mockReturnValue(Promise.resolve());
  }),
  PostMessageTransport: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("@/lib/config/config", () => ({
  getMcpSandboxBaseUrl: () => ({
    baseUrl: "http://127.0.0.1:9000",
    hasCrossOrigin: true,
  }),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => null,
}));

// ── Import component under test after mocks ───────────────────────────────────

import { McpAppSection } from "./mcp-app-container";

// ── Helpers ──────────────────────────────────────────────────────────────────

const defaultProps = {
  uiResourceUri: "resource://test-server/ui",
  agentId: "00000000-0000-0000-0000-000000000001",
  toolName: "test-server__get-data",
  rawOutput: { content: "some result" },
};

const preloadedResource = {
  html: "<div>Hello MCP App</div>",
  csp: { connectDomains: ["api.example.com"] },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("McpAppSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading spinner when resource has not yet loaded", () => {
    render(<McpAppSection {...defaultProps} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders sandbox iframe once preloadedResource is provided", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={preloadedResource}
        />,
      );
    });

    // SandboxIframe creates an iframe element in the DOM
    const iframe = document.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
  });

  it("sets correct sandbox attribute with allow-same-origin when cross-origin", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={preloadedResource}
        />,
      );
    });

    const iframe = document.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
    const sandbox = iframe?.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-forms");
    // With cross-origin (localhost swap or domain mode), allow-same-origin is set
    expect(sandbox).toContain("allow-same-origin");
  });

  it("does not show loading spinner once sandbox iframe is rendered", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={preloadedResource}
        />,
      );
    });

    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("does not reserve a canvas panel for empty static app HTML", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={{
            html: "<!doctype html><html><body></body></html>",
          }}
        />,
      );
    });

    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("keeps script-driven app HTML because it may render after initialization", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={{
            html: "<!doctype html><html><body><script>document.body.textContent = 'loaded'</script></body></html>",
          }}
        />,
      );
    });

    expect(document.querySelector("iframe")).toBeInTheDocument();
  });

  it("keeps app HTML that bootstraps from a <head> module script into an empty body", async () => {
    // Excalidraw and most SPA-style MCP Apps ship their bootstrap as a <head>
    // module script that mounts into an otherwise-empty <body>. The body has no
    // visible content until the script runs, so the renderability heuristic must
    // look beyond <body> or these apps render as a blank panel.
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={{
            html: '<!doctype html><html><head><script type="module">import { createRoot } from "react-dom/client"; createRoot(document.body).render(null)</script></head><body></body></html>',
          }}
        />,
      );
    });

    expect(document.querySelector("iframe")).toBeInTheDocument();
  });
});

describe("McpAppContainer (via McpAppSection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides close button in inline mode", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={preloadedResource}
        />,
      );
    });

    // The Exit-fullscreen button only mounts while in fullscreen mode.
    expect(
      screen.queryByRole("button", { name: /exit fullscreen/i }),
    ).not.toBeInTheDocument();
  });

  it("shows close button after switching to fullscreen mode", async () => {
    const user = userEvent.setup();

    const { AppBridge } = await import(
      "@modelcontextprotocol/ext-apps/app-bridge"
    );
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    (AppBridge as ReturnType<typeof vi.fn>).mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      this.onrequestdisplaymode = null as
        | null
        | ((args: { mode: string }) => Promise<{ mode: string }>);
      this.onopenlink = null;
      this.oncalltool = null;
      this.onreadresource = null;
      this.onlistresources = null;
      this.onlistresourcetemplates = null;
      this.onlistprompts = null;
      this.onloggingmessage = null;
      this.onmessage = null;
      this.onsizechange = null;
      this.oninitialized = null;
      this.onsandboxready = null;
      this.connect = vi.fn().mockReturnValue(Promise.resolve());
      this.sendSandboxResourceReady = vi
        .fn()
        .mockReturnValue(Promise.resolve());
      this.sendToolInput = vi.fn().mockReturnValue(Promise.resolve());
      this.sendToolInputPartial = vi.fn().mockReturnValue(Promise.resolve());
      this.sendToolResult = vi.fn().mockReturnValue(Promise.resolve());
      this.setHostContext = vi.fn();
      this.teardownResource = vi.fn().mockReturnValue(Promise.resolve());
      bridgeInstances.push(this);
    });

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={preloadedResource}
        />,
      );
    });

    // Trigger fullscreen via the bridge's onrequestdisplaymode handler
    const bridge = bridgeInstances[0];
    if (bridge?.onrequestdisplaymode) {
      await act(async () => {
        await bridge.onrequestdisplaymode({ mode: "fullscreen" });
      });
    }

    // The close button should now be visible
    expect(
      screen.getByRole("button", { name: /exit fullscreen/i }),
    ).toBeInTheDocument();

    // Clicking it should return to inline mode (close button unmounts)
    const closeButton = screen.getByRole("button", {
      name: /exit fullscreen/i,
    });
    await act(async () => {
      await user.click(closeButton);
    });

    expect(
      screen.queryByRole("button", { name: /exit fullscreen/i }),
    ).not.toBeInTheDocument();
  });
});

describe("McpAppSection error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows error message when fetch fails (no preloaded resource)", async () => {
    // Mock global fetch to simulate a network error
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network error"));

    await act(async () => {
      render(<McpAppSection {...defaultProps} />);
    });

    // Wait for the async fetch to complete and error state to render
    await vi.waitFor(() => {
      expect(
        screen.getByText(/failed to load/i) || screen.getByText(/error/i),
      ).toBeTruthy();
    });

    fetchSpy.mockRestore();
  });
});
