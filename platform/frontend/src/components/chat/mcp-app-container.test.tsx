import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
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

import {
  clearAllAppDiagnostics,
  reportAppDiagnostic,
} from "@/lib/chat/app-diagnostics-store";
import { AppsProvider, useApps } from "./apps-context";
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

describe("McpAppContainer inline height (via McpAppSection)", () => {
  const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
  // Matches the mocked getMcpSandboxBaseUrl baseUrl origin.
  const SANDBOX_ORIGIN = "http://127.0.0.1:9000";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Drives the app into the sidebar portal so renderInSidebar becomes true.
  function SidebarDriver({ target }: { target: HTMLElement }) {
    const { setPortalTarget, select } = useApps();
    useEffect(() => {
      setPortalTarget(target);
      select("tc1");
    }, [setPortalTarget, select, target]);
    return null;
  }

  // Capture the live bridge and drive the sandbox-proxy handshake so the
  // runtime binds `onsizechange` (it is gated on sandbox-ready). The iframe
  // proxy is a true process boundary, so faking its ready message is legitimate.
  async function renderReadyApp(
    viewportHeight: number,
    { sidebar = false }: { sidebar?: boolean } = {},
  ) {
    Object.defineProperty(window, "innerHeight", {
      value: viewportHeight,
      configurable: true,
    });

    const { AppBridge } = await import(
      "@modelcontextprotocol/ext-apps/app-bridge"
    );
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    (AppBridge as ReturnType<typeof vi.fn>).mockImplementation(function (
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
        sidebar ? (
          <AppsProvider
            apps={[{ toolCallId: "tc1", label: "app", createdAt: 0 }]}
          >
            <SidebarDriver target={document.body} />
            <McpAppSection
              {...defaultProps}
              toolCallId="tc1"
              preloadedResource={preloadedResource}
            />
          </AppsProvider>
        ) : (
          <McpAppSection
            {...defaultProps}
            preloadedResource={preloadedResource}
          />
        ),
      );
    });

    const iframe = document.querySelector("iframe");
    if (!iframe) throw new Error("iframe did not mount");

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: SANDBOX_ORIGIN,
          data: { method: SANDBOX_PROXY_READY },
        }),
      );
    });

    const bridge = bridgeInstances[bridgeInstances.length - 1];
    if (typeof bridge?.onsizechange !== "function") {
      throw new Error("onsizechange was not bound after sandbox-ready");
    }
    return bridge;
  }

  function inlineMaxHeightPx(): number {
    const el = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
      (e) => e.style.maxHeight !== "",
    );
    if (!el) throw new Error("no element carries a max-height style");
    return Number.parseFloat(el.style.maxHeight);
  }

  // biome-ignore lint/suspicious/noExplicitAny: reading mock call args
  function lastGuestContainerDimensions(bridge: any): unknown {
    const calls = bridge.setHostContext.mock.calls;
    return calls[calls.length - 1]?.[0]?.containerDimensions;
  }

  it("caps the inline card at a viewport fraction, well above the legacy 500px", async () => {
    const bridge = await renderReadyApp(2000);

    await act(async () => {
      bridge.onsizechange({ height: 700 });
    });

    expect(inlineMaxHeightPx()).toBe(700);
    expect(inlineMaxHeightPx()).not.toBe(500);
  });

  it("clamps a report taller than the ceiling to the ceiling", async () => {
    const bridge = await renderReadyApp(2000);

    await act(async () => {
      bridge.onsizechange({ height: 100_000 });
    });

    // ceiling = round(2000 * 0.6) = 1200
    expect(inlineMaxHeightPx()).toBe(1200);
  });

  it("hints the viewport ceiling to the guest, not the legacy 500px", async () => {
    const bridge = await renderReadyApp(2000);
    // ceiling = round(2000 * 0.6) = 1200
    expect(lastGuestContainerDimensions(bridge)).toEqual({ maxHeight: 1200 });
  });

  it("hints no cap to the guest when the app fills the sidebar", async () => {
    const bridge = await renderReadyApp(2000, { sidebar: true });
    expect(lastGuestContainerDimensions(bridge)).toEqual({});
  });
});

describe("McpAppSection sidebar hosting", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAppDiagnostics();
  });

  // Opens the sidebar app host (portalTarget) so the selected owned-app section
  // portals its iframe into the target.
  function SidebarHost({ target }: { target: HTMLElement }) {
    const { setPortalTarget } = useApps();
    useEffect(() => {
      setPortalTarget(target);
    }, [setPortalTarget, target]);
    return null;
  }

  it("hosts an owned-app render in the sidebar app host", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    await act(async () => {
      render(
        <AppsProvider
          apps={[{ toolCallId: "tc1", label: "To Do App", createdAt: 0 }]}
        >
          <SidebarHost target={target} />
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    // Opening the app host auto-selects the sole app, portaling the live
    // owned-app iframe into the sidebar target (not left inline).
    expect(target.querySelector("iframe")).toBeInTheDocument();
    expect(screen.getByText(/showing in sidebar/i)).toBeInTheDocument();

    target.remove();
  });

  it("keeps the diagnostics badge out of the stretched app wrapper when hosted", async () => {
    // The error badge must not share the fill-container wrapper with the iframe:
    // that wrapper applies `[&>div]:!h-full`, so a badge inside it gets stretched
    // to full height and shoves the iframe below the sidebar fold (blank render).
    reportAppDiagnostic(APP_ID, 1, {
      type: "csp-violation",
      message: "script-src blocked eval",
    });
    const target = document.createElement("div");
    document.body.appendChild(target);

    await act(async () => {
      render(
        <AppsProvider
          apps={[{ toolCallId: "tc1", label: "To Do App", createdAt: 0 }]}
        >
          <SidebarHost target={target} />
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    const iframe = target.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
    const badge = within(target).getByText(/runtime error/i);

    // The nearest overflow-hidden wrapper of the iframe is the fill-container
    // clip box that stretches its `> div` children; the badge must sit OUTSIDE
    // it, or it gets sized to full height and pushes the iframe off-screen.
    let clipWrapper: HTMLElement | null = iframe?.parentElement ?? null;
    while (
      clipWrapper &&
      clipWrapper !== target &&
      !clipWrapper.className.includes("overflow-hidden")
    ) {
      clipWrapper = clipWrapper.parentElement;
    }
    expect(clipWrapper).not.toBeNull();
    expect(clipWrapper?.contains(badge)).toBe(false);

    target.remove();
  });

  it("offers a Show in sidebar control for a second, unselected app", async () => {
    const user = userEvent.setup();
    const target = document.createElement("div");
    document.body.appendChild(target);

    await act(async () => {
      render(
        // tc1 is the latest (greatest createdAt), so it becomes the default
        // selection and the rendered tc2 section stays unselected.
        <AppsProvider
          apps={[
            { toolCallId: "tc1", label: "First App", createdAt: 1 },
            { toolCallId: "tc2", label: "Second App", createdAt: 0 },
          ]}
        >
          <SidebarHost target={target} />
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            toolCallId="tc2"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    // tc1 auto-selected (latest), so tc2 shows the placeholder control; clicking
    // it selects tc2 and portals its iframe into the sidebar target.
    const showButton = screen.getByRole("button", { name: /show in sidebar/i });
    expect(target.querySelector("iframe")).not.toBeInTheDocument();

    await act(async () => {
      await user.click(showButton);
    });

    expect(target.querySelector("iframe")).toBeInTheDocument();
    expect(screen.getByText(/showing in sidebar/i)).toBeInTheDocument();

    target.remove();
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
