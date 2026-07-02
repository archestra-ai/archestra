import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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

vi.mock("@/lib/config/config.query");

// Avoid pulling the real auth client / app query (and their network deps) into
// the test; the edit pencil is covered by app-frame.test.tsx.
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: false }),
}));

vi.mock("@/lib/app.query", () => ({
  useApp: vi.fn(() => ({ data: undefined })),
  useDeleteApp: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
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
import { useFeature } from "@/lib/config/config.query";
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
    vi.mocked(useFeature).mockReturnValue(
      null as unknown as ReturnType<typeof useFeature>,
    );
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
        // The panel surface shows the app title in its address pill.
        <McpAppSection
          {...defaultProps}
          surface="panel"
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
        <McpAppSection
          {...defaultProps}
          surface={panel ? "panel" : "inline"}
          preloadedResource={preloadedResource}
        />,
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
    // clearAllMocks resets calls but not return values, so restore the default.
    mockUseApp.mockReturnValue({ data: undefined } as ReturnType<
      typeof useApp
    >);
  });

  it("renders the live app on the panel surface", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="panel"
          appId={APP_ID}
          toolCallId="tc1"
          preloadedResource={preloadedResource}
        />,
      );
    });

    // The panel surface mounts the live app card directly (no portal).
    expect(document.querySelector("iframe")).toBeInTheDocument();
  });

  it("keeps app diagnostics out of the panel surface (they live inline)", async () => {
    // Runtime diagnostics belong to the chat stream, never the height-constrained
    // panel — so a reported error surfaces on the inline surface, not the panel.
    reportAppDiagnostic(APP_ID, 1, {
      type: "csp-violation",
      message: "script-src blocked eval",
    });

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="panel"
          appId={APP_ID}
          toolCallId="tc1"
          preloadedResource={preloadedResource}
        />,
      );
    });

    expect(document.querySelector("iframe")).toBeInTheDocument();
    expect(screen.queryByText(/runtime error/i)).not.toBeInTheDocument();
  });

  it("resolves the open app to the latest while the panel hosts, even after an inline collapse", async () => {
    // Repro: collapsing every inline app sets the open app to null (correct for
    // the chat stream). Opening the panel afterwards must still host an app —
    // the Apps tab has no "nothing open" state — so a null collapse falls back
    // to the latest app while the panel is hosting (portalTarget set).
    const user = userEvent.setup();

    function Probe() {
      const { openToolCallId, setOpenToolCallId, setPortalTarget } = useApps();
      return (
        <div>
          <div data-testid="open">{openToolCallId ?? "none"}</div>
          <button type="button" onClick={() => setOpenToolCallId(null)}>
            collapse
          </button>
          <button
            type="button"
            onClick={() => setPortalTarget(document.createElement("div"))}
          >
            host panel
          </button>
        </div>
      );
    }

    await act(async () => {
      render(
        <AppsProvider
          apps={[
            {
              toolCallId: "tc1",
              label: "First App",
              uiResourceUri: "resource://test-server/ui-other",
              createdAt: 0,
            },
            {
              toolCallId: "tc2",
              label: "Second App",
              uiResourceUri: defaultProps.uiResourceUri,
              createdAt: 1,
            },
          ]}
        >
          <Probe />
        </AppsProvider>,
      );
    });

    // Untouched → the latest app (tc2) is open.
    expect(screen.getByTestId("open")).toHaveTextContent("tc2");

    // Collapse all inline apps → nothing open (no panel hosting yet).
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "collapse" }));
    });
    expect(screen.getByTestId("open")).toHaveTextContent("none");

    // Opening the panel (portalTarget set) must resolve back to the latest app
    // rather than leaving the tab blank.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "host panel" }));
    });
    expect(screen.getByTestId("open")).toHaveTextContent("tc2");
  });

  it("collapses a non-open app to a pill while another app is open", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(
        // tc1 is the latest (greatest createdAt), so it's the default open app;
        // the rendered tc2 section is not open and collapses to a pill.
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
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            toolCallId="tc2"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    // One app open at a time: tc2 shows only its pill, no live iframe.
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    const pill = screen.getByRole("button", { name: /get-data/i });

    // Clicking the pill opens tc2 inline.
    await act(async () => {
      await user.click(pill);
    });
    expect(document.querySelector("iframe")).toBeInTheDocument();
  });
});

describe("McpAppSection older renders (no suppression)", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAppDiagnostics();
    mockUseApp.mockReturnValue({ data: undefined } as ReturnType<
      typeof useApp
    >);
  });

  it("hides the diagnostics panel while the app is closed, shows it once opened", async () => {
    const user = userEvent.setup();
    reportAppDiagnostic(APP_ID, 1, {
      type: "csp-violation",
      message: "script-src blocked eval",
    });

    await act(async () => {
      render(
        // Another app (tc-other) is newest, so it's the default open one and the
        // rendered APP_ID section (tc1) starts closed.
        <AppsProvider
          apps={[
            {
              toolCallId: "tc-other",
              label: "Other App",
              uiResourceUri: "resource://test-server/ui-other",
              createdAt: 1,
            },
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
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    // Closed: the error is hidden along with the iframe.
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.queryByText(/runtime error/i)).not.toBeInTheDocument();

    // Opening the pill reveals both the app and its diagnostics.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Dashboard" }));
    });
    expect(document.querySelector("iframe")).toBeInTheDocument();
    expect(screen.getByText(/runtime error/i)).toBeInTheDocument();
  });

  it("shows an older owned render as a plain pill (app name only) that opens inline on click", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(
        // Both renders live in the registry (no dedup). tc2 is newest, so it's
        // the default-open app; the rendered older tc1 section shows just a pill
        // labelled with the app name — no "· v1 · Updated" changelog text.
        <AppsProvider
          apps={[
            {
              toolCallId: "tc1",
              label: "Dashboard",
              uiResourceUri: defaultProps.uiResourceUri,
              appId: APP_ID,
              createdAt: 0,
            },
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

    // Plain pill, app name only, and not open (tc2 is the default open app).
    const pill = screen.getByRole("button", { name: "Dashboard" });
    expect(screen.queryByText(/· Updated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/v1/)).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();

    // Clicking the older pill opens its app inline (latest version, under it).
    await act(async () => {
      await user.click(pill);
    });
    expect(document.querySelector("iframe")).toBeInTheDocument();
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

describe("McpAppSection unavailable owned app", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
    // A settled 404: the app was deleted or access was lost.
    mockUseApp.mockReturnValue({ data: null, isSuccess: true } as ReturnType<
      typeof useApp
    >);
  });

  it("shows a plain pill and reveals the error message only when expanded", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          appId={APP_ID}
          appName="Dashboard"
          toolCallId="tc1"
          preloadedResource={preloadedResource}
        />,
      );
    });

    // Collapsed: just the pill, no error text, and never the runtime (would 404).
    const pill = screen.getByRole("button", { name: "Dashboard" });
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();

    // Expanding shows the unavailable message; the runtime still never mounts.
    await act(async () => {
      await user.click(pill);
    });
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
  });
});

describe("McpAppSection owned-app panel chrome", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAppDiagnostics();
  });

  // Renders an owned app on the panel surface so the panel chrome (settings gear
  // + app-settings dialog) is active.
  async function renderOwnedPanel() {
    mockUseApp.mockReturnValue({
      data: { id: APP_ID, name: "To Do App" },
    } as ReturnType<typeof useApp>);
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
          <McpAppSection
            {...defaultProps}
            surface="panel"
            appId={APP_ID}
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });
  }

  it("opens the app settings dialog from the panel gear", async () => {
    const user = userEvent.setup();
    await renderOwnedPanel();

    // Chrome shows a Settings button over the live app; the dialog starts closed.
    const gear = screen.getByRole("button", { name: /^settings$/i });
    expect(document.querySelector("iframe")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-form")).not.toBeInTheDocument();

    // Clicking it opens the settings dialog (a modal over the live app).
    await act(async () => {
      await user.click(gear);
    });
    expect(screen.getByTestId("settings-form")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();

    // Cancel closes the dialog and returns to the live app.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /cancel/i }));
    });
    expect(screen.queryByTestId("settings-form")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^settings$/i }),
    ).toBeInTheDocument();
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
