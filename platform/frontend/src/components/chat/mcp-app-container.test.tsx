import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect } from "react";
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

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
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

// Avoid pulling the real auth client / app query (and their network deps) into
// the test; the edit pencil is covered by app-frame.test.tsx.
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: false }),
}));

vi.mock("@/lib/app.query", () => ({
  useApp: vi.fn(() => ({ data: undefined })),
}));

// Stub the inline settings form: it pulls the environment/teams/auth query
// chains, which aren't this suite's concern (covered by their own tests). Here
// we only assert the panel chrome toggles it from the gear.
vi.mock("@/components/mcp-app/app-settings-form", () => ({
  AppSettingsForm: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="settings-form">
      <button type="button" onClick={onBack}>
        mock back
      </button>
    </div>
  ),
}));

// ── Import component under test after mocks ───────────────────────────────────

import { useApp } from "@/lib/app.query";
import {
  clearAllAppDiagnostics,
  reportAppDiagnostic,
} from "@/lib/chat/app-diagnostics-store";
import { AppsProvider, useApps } from "./apps-context";
import { McpAppSection } from "./mcp-app-container";

const mockUseApp = vi.mocked(useApp);

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

  it("titles an owned app from the live query, not the captured appName prop", async () => {
    // After an edit invalidates the app query, the address bar must reflect the
    // new name even though the appName prop was captured at render time.
    mockUseApp.mockReturnValue({
      data: { name: "Renamed Dashboard" },
    } as ReturnType<typeof useApp>);

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          appId="11111111-1111-1111-1111-111111111111"
          appName="Stale Dashboard"
          preloadedResource={preloadedResource}
        />,
      );
    });

    expect(screen.getByText("Renamed Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Stale Dashboard")).not.toBeInTheDocument();
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

  // Drives the app into the panel portal so renderInPanel becomes true.
  function PanelDriver({ target }: { target: HTMLElement }) {
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
    { panel = false }: { panel?: boolean } = {},
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
        panel ? (
          <AppsProvider
            apps={[
              {
                toolCallId: "tc1",
                label: "app",
                uiResourceUri: defaultProps.uiResourceUri,
                createdAt: 0,
              },
            ]}
          >
            <PanelDriver target={document.body} />
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

  function inlineIframeHeightPx(): number {
    const iframe = document.querySelector("iframe");
    if (!iframe) throw new Error("iframe did not mount");
    return Number.parseFloat(iframe.style.height);
  }

  // biome-ignore lint/suspicious/noExplicitAny: reading mock call args
  function lastGuestContainerDimensions(bridge: any): unknown {
    const calls = bridge.setHostContext.mock.calls;
    return calls[calls.length - 1]?.[0]?.containerDimensions;
  }

  it("grows the inline app to its reported height", async () => {
    const bridge = await renderReadyApp(2000);

    await act(async () => {
      bridge.onsizechange({ height: 700 });
    });

    expect(inlineIframeHeightPx()).toBe(700);
  });

  it("caps an oversized inline report at the card's visual ceiling", async () => {
    // innerHeight 2000 → ceiling max(320px, 60vh) = 1200. A viewport-relative
    // app that reports an ever-growing height is clamped here so the iframe
    // can't inflate without bound (content scrolls within it instead).
    const bridge = await renderReadyApp(2000);

    await act(async () => {
      bridge.onsizechange({ height: 100_000 });
    });

    expect(inlineIframeHeightPx()).toBe(1200);
  });

  it("hints the inline ceiling to the guest", async () => {
    // innerHeight 2000 → 60vh = 1200. The host shares this honest ceiling so a
    // cooperative app can lay out within it.
    const bridge = await renderReadyApp(2000);
    expect(lastGuestContainerDimensions(bridge)).toEqual({ maxHeight: 1200 });
  });

  it("hints no cap to the guest when the app fills the panel", async () => {
    const bridge = await renderReadyApp(2000, { panel: true });
    expect(lastGuestContainerDimensions(bridge)).toEqual({});
  });
});

describe("McpAppSection panel hosting", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAppDiagnostics();
  });

  // Opens the panel app host (portalTarget) so the selected owned-app section
  // portals its iframe into the target.
  function PanelHost({ target }: { target: HTMLElement }) {
    const { setPortalTarget } = useApps();
    useEffect(() => {
      setPortalTarget(target);
    }, [setPortalTarget, target]);
    return null;
  }

  it("hosts an owned-app render in the panel app host", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    await act(async () => {
      render(
        <AppsProvider
          apps={[
            {
              toolCallId: "tc1",
              label: "To Do App",
              uiResourceUri: defaultProps.uiResourceUri,
              createdAt: 0,
            },
          ]}
        >
          <PanelHost target={target} />
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
    // owned-app iframe into the panel target (not left inline).
    expect(target.querySelector("iframe")).toBeInTheDocument();
    expect(screen.getByText(/showing in panel/i)).toBeInTheDocument();

    target.remove();
  });

  it("keeps the diagnostics badge out of the stretched app wrapper when hosted", async () => {
    // The error badge must not share the fill-container wrapper with the iframe:
    // that wrapper applies `[&>div]:!h-full`, so a badge inside it gets stretched
    // to full height and shoves the iframe below the panel fold (blank render).
    reportAppDiagnostic(APP_ID, 1, {
      type: "csp-violation",
      message: "script-src blocked eval",
    });
    const target = document.createElement("div");
    document.body.appendChild(target);

    await act(async () => {
      render(
        <AppsProvider
          apps={[
            {
              toolCallId: "tc1",
              label: "To Do App",
              uiResourceUri: defaultProps.uiResourceUri,
              createdAt: 0,
            },
          ]}
        >
          <PanelHost target={target} />
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

  it("keeps a second, unselected app live inline while the panel hosts another", async () => {
    const user = userEvent.setup();
    const target = document.createElement("div");
    document.body.appendChild(target);

    await act(async () => {
      render(
        // tc1 is the latest (greatest createdAt), so it becomes the default
        // selection and the rendered tc2 section stays unselected.
        <AppsProvider
          apps={[
            {
              toolCallId: "tc1",
              label: "First App",
              uiResourceUri: "resource://test-server/ui-other",
              createdAt: 1,
            },
            {
              toolCallId: "tc2",
              label: "Second App",
              uiResourceUri: defaultProps.uiResourceUri,
              createdAt: 0,
            },
          ]}
        >
          <PanelHost target={target} />
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            toolCallId="tc2"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    // tc1 is auto-selected and hosted in the panel. The unselected tc2 keeps
    // rendering live inline (not a placeholder) and is NOT shown in the panel,
    // while still offering its own Show in panel control.
    const showButton = screen.getByRole("button", { name: /show in panel/i });
    expect(target.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.queryByText(/showing in panel/i)).not.toBeInTheDocument();
    // tc2's live iframe renders inline (in the document, outside the panel target).
    expect(document.querySelector("iframe")).toBeInTheDocument();

    // Clicking it selects tc2 and portals its iframe into the panel target.
    await act(async () => {
      await user.click(showButton);
    });

    expect(target.querySelector("iframe")).toBeInTheDocument();
    expect(screen.getByText(/showing in panel/i)).toBeInTheDocument();

    target.remove();
  });
});

describe("McpAppSection superseded renders", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collapses to a changelog pill when a newer render of the same app exists", async () => {
    await act(async () => {
      render(
        // Registry's latest render of APP_ID is tc2, so the tc1 section below is
        // superseded and must render the static pill, not a live iframe.
        <AppsProvider
          apps={[
            {
              toolCallId: "tc2",
              label: "Dashboard",
              uiResourceUri: defaultProps.uiResourceUri,
              appId: APP_ID,
              createdAt: 1,
            },
          ]}
        >
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            appName="Dashboard"
            appVersion={1}
            toolName="archestra__edit_app"
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    expect(screen.getByText(/Dashboard · v1 · Updated/)).toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("renders the live surface for the latest render of an app", async () => {
    await act(async () => {
      render(
        <AppsProvider
          apps={[
            {
              toolCallId: "tc1",
              label: "Dashboard",
              uiResourceUri: defaultProps.uiResourceUri,
              appId: APP_ID,
              createdAt: 0,
            },
          ]}
        >
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            appName="Dashboard"
            appVersion={1}
            toolName="archestra__edit_app"
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    expect(document.querySelector("iframe")).toBeInTheDocument();
    expect(screen.queryByText(/· Updated/)).not.toBeInTheDocument();
  });
});

describe("McpAppSection owned-app panel chrome", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAppDiagnostics();
  });

  function PanelHost({ target }: { target: HTMLElement }) {
    const { setPortalTarget } = useApps();
    useEffect(() => {
      setPortalTarget(target);
    }, [setPortalTarget, target]);
    return null;
  }

  // Renders an owned app selected into the panel host so the tabbed chrome
  // branch (renderInPanel && appId && ownedApp) is active. The live card portals
  // into `target`.
  async function renderOwnedPanel() {
    mockUseApp.mockReturnValue({
      data: { id: APP_ID, name: "To Do App" },
    } as ReturnType<typeof useApp>);
    const target = document.createElement("div");
    document.body.appendChild(target);
    await act(async () => {
      render(
        <AppsProvider
          apps={[
            {
              toolCallId: "tc1",
              label: "To Do App",
              uiResourceUri: defaultProps.uiResourceUri,
              createdAt: 0,
            },
          ]}
        >
          <PanelHost target={target} />
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });
    return target;
  }

  it("toggles the inline settings form from the panel gear", async () => {
    const user = userEvent.setup();
    const target = await renderOwnedPanel();

    // Chrome shows a single settings gear (no dropdown / publish popover) over
    // the live app.
    const gear = within(target).getByRole("button", { name: /app settings/i });
    expect(target.querySelector("iframe")).toBeInTheDocument();
    expect(
      within(target).queryByTestId("settings-form"),
    ).not.toBeInTheDocument();

    // Clicking it swaps the body for the settings form (live iframe unmounts).
    await act(async () => {
      await user.click(gear);
    });
    expect(within(target).getByTestId("settings-form")).toBeInTheDocument();
    expect(target.querySelector("iframe")).not.toBeInTheDocument();

    // In settings mode the bar shows a back arrow (cancel) and a save action;
    // clicking back returns to the live app and restores the gear.
    expect(
      within(target).getByRole("button", { name: /save settings/i }),
    ).toBeInTheDocument();
    await act(async () => {
      await user.click(
        within(target).getByRole("button", { name: /back to app/i }),
      );
    });
    expect(
      within(target).queryByTestId("settings-form"),
    ).not.toBeInTheDocument();
    expect(
      within(target).getByRole("button", { name: /app settings/i }),
    ).toBeInTheDocument();

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
