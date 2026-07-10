import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock heavy dependencies before module import ─────────────────────────────

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", async (importActual) => ({
  // Keep pure helpers (e.g. buildAllowAttribute) real; only stub the stateful
  // classes the tests need to control.
  ...(await importActual<
    typeof import("@modelcontextprotocol/ext-apps/app-bridge")
  >()),
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

  it("keeps the tool-call details inspectable when the app HTML is empty", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={{
            html: "<!doctype html><html><body></body></html>",
          }}
          toolDetails={<div data-testid="tool-details">details</div>}
        />,
      );
    });

    // A blank app document reserves no canvas, but its tool-call details — the
    // input/output a user needs to diagnose why it rendered blank — must remain.
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-details")).toBeInTheDocument();
  });

  it("shows an explicit empty state in the panel when the app HTML is empty", async () => {
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="panel"
          preloadedResource={{
            html: "<!doctype html><html><body></body></html>",
          }}
        />,
      );
    });

    // The panel is opened deliberately and carries no tool details, so a blank
    // app must not leave a completely empty panel with no indication.
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(
      screen.getByText("This app rendered nothing to display."),
    ).toBeInTheDocument();
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

  it("seeds the panel-hosted guest with the tool result (parity with inline)", async () => {
    // Regression from #6163 (portal removal): the fresh panel iframe must be
    // seeded with the tool result — otherwise an app that renders from the
    // pushed result re-calls its source tool live, which 404s for tools that
    // aren't directly listed on the gateway.
    const bridge = await renderReadyApp(2000, { panel: true });
    await act(async () => {
      bridge.oninitialized();
    });
    expect(bridge.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "some result" }],
      }),
    );
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

  it("keeps the panel resolved to a single app even after every inline app is collapsed", async () => {
    // The Apps tab has no "nothing open" state: the panel must always host one
    // app. Collapsing every inline app must not blank it — it falls back to the
    // latest app.
    const user = userEvent.setup();

    function Probe() {
      const { panelToolCallId, toggleAppOpen, setPortalTarget } = useApps();
      return (
        <div>
          <div data-testid="panel">{panelToolCallId ?? "none"}</div>
          <button
            type="button"
            onClick={() => {
              toggleAppOpen("tc1");
              toggleAppOpen("tc2");
            }}
          >
            collapse all
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

    // Untouched → the latest app (tc2) is the panel's app.
    expect(screen.getByTestId("panel")).toHaveTextContent("tc2");

    // Collapsing every inline app must not blank the panel — it stays on tc2.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "collapse all" }));
    });
    expect(screen.getByTestId("panel")).toHaveTextContent("tc2");

    // Hosting the panel keeps it on that single app.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "host panel" }));
    });
    expect(screen.getByTestId("panel")).toHaveTextContent("tc2");
  });

  it("hosts the picked render in the panel after collapsing every app", async () => {
    // With no explicit panel pick and every app collapsed, the panel falls back
    // to the group's active render — honoring an older-render pick — rather than
    // the raw latest render.
    const user = userEvent.setup();

    function Probe() {
      const { panelToolCallId, toggleAppOpen } = useApps();
      return (
        <div>
          <div data-testid="panel">{panelToolCallId ?? "none"}</div>
          <button type="button" onClick={() => toggleAppOpen("tc1")}>
            toggle tc1
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
          <Probe />
        </AppsProvider>,
      );
    });

    // Untouched → the latest render (tc2) is active and hosted.
    expect(screen.getByTestId("panel")).toHaveTextContent("tc2");

    // Picking the older render tc1 makes it active and hosted.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "toggle tc1" }));
    });
    expect(screen.getByTestId("panel")).toHaveTextContent("tc1");

    // Collapsing the app (second toggle) keeps the panel on the picked render.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "toggle tc1" }));
    });
    expect(screen.getByTestId("panel")).toHaveTextContent("tc1");
  });

  it("expands each app inline by default and toggles just that app with its pill", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(
        // Every app expands inline by default, so the rendered tc2 section shows
        // its live app immediately rather than only when it is the latest.
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

    // Open by default: the live iframe is mounted.
    expect(document.querySelector("iframe")).toBeInTheDocument();
    const pill = screen.getByRole("button", { name: /get-data/i });

    // Clicking the pill collapses just this app.
    await act(async () => {
      await user.click(pill);
    });
    expect(document.querySelector("iframe")).not.toBeInTheDocument();

    // Clicking again reopens it.
    await act(async () => {
      await user.click(pill);
    });
    expect(document.querySelector("iframe")).toBeInTheDocument();
  });
});

describe("AppsProvider newly rendered app after manual toggles", () => {
  // The repro: app A rendered → user closes → user opens (manual toggles) →
  // app B rendered. B must open automatically on both surfaces.
  const appA = {
    toolCallId: "tc-a",
    label: "First App",
    uiResourceUri: "resource://test-server/ui-a",
    createdAt: 1,
  };
  const appB = {
    toolCallId: "tc-b",
    label: "Second App",
    uiResourceUri: "resource://test-server/ui-b",
    createdAt: 2,
  };

  function Probe() {
    const { panelToolCallId, isAppOpen, toggleAppOpen, setPanelApp } =
      useApps();
    return (
      <div>
        <div data-testid="panel">{panelToolCallId ?? "none"}</div>
        <div data-testid="open-a">{String(isAppOpen("tc-a"))}</div>
        <div data-testid="open-b">{String(isAppOpen("tc-b"))}</div>
        <button type="button" onClick={() => toggleAppOpen("tc-a")}>
          toggle a
        </button>
        <button type="button" onClick={() => setPanelApp("tc-a")}>
          pick a
        </button>
      </div>
    );
  }

  it("hosts a newly rendered app in the panel even after an explicit manual pick", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AppsProvider apps={[appA]}>
        <Probe />
      </AppsProvider>,
    );

    // Step 1: the user collapses the app, reopens it, and pins it to the panel
    // ("Open in right panel" / a pill click while the panel hosts).
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "toggle a" }));
      await user.click(screen.getByRole("button", { name: "toggle a" }));
      await user.click(screen.getByRole("button", { name: "pick a" }));
    });
    expect(screen.getByTestId("panel")).toHaveTextContent("tc-a");

    // Step 2: the model renders a second, different app.
    rerender(
      <AppsProvider apps={[appA, appB]}>
        <Probe />
      </AppsProvider>,
    );

    // The new render supersedes the manual pick: it takes the panel, open.
    expect(screen.getByTestId("panel")).toHaveTextContent("tc-b");
    expect(screen.getByTestId("open-b")).toHaveTextContent("true");
  });

  it("keeps honoring the manual panel pick while no new render arrives", async () => {
    const user = userEvent.setup();
    render(
      <AppsProvider apps={[appA, appB]}>
        <Probe />
      </AppsProvider>,
    );

    // tc-b is newest and hosted by default; picking tc-a moves the panel and it
    // stays there — supersession needs a render that postdates the pick.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "pick a" }));
    });
    expect(screen.getByTestId("panel")).toHaveTextContent("tc-a");

    // An unrelated inline collapse doesn't unseat the pick either.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "toggle a" }));
    });
    expect(screen.getByTestId("panel")).toHaveTextContent("tc-a");
  });

  it("keeps a newly rendered app expanded inline alongside a manually reopened one", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AppsProvider apps={[appA]}>
        <Probe />
      </AppsProvider>,
    );

    // Step 1 with no panel: collapse the app, then reopen it.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "toggle a" }));
    });
    expect(screen.getByTestId("open-a")).toHaveTextContent("false");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "toggle a" }));
    });
    expect(screen.getByTestId("open-a")).toHaveTextContent("true");

    // Step 2: the model renders a second app — both stay expanded inline.
    rerender(
      <AppsProvider apps={[appA, appB]}>
        <Probe />
      </AppsProvider>,
    );
    expect(screen.getByTestId("open-a")).toHaveTextContent("true");
    expect(screen.getByTestId("open-b")).toHaveTextContent("true");
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

  it("shows the diagnostics panel while the app is open and hides it once collapsed", async () => {
    const user = userEvent.setup();
    reportAppDiagnostic(APP_ID, 1, {
      type: "csp-violation",
      message: "script-src blocked eval",
    });

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
            toolCallId="tc1"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      );
    });

    // Open by default: both the app and its diagnostics are visible.
    expect(document.querySelector("iframe")).toBeInTheDocument();
    expect(screen.getByText(/runtime error/i)).toBeInTheDocument();

    // Collapsing the app hides the error along with the iframe.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Dashboard" }));
    });
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.queryByText(/runtime error/i)).not.toBeInTheDocument();
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

describe("McpAppSection multi-open", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAppDiagnostics();
    mockUseApp.mockReturnValue({ data: undefined } as ReturnType<
      typeof useApp
    >);
  });

  it("shows one instance of a repeated owned app and moves it to the clicked render", async () => {
    const user = userEvent.setup();
    const apps = [
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
    ];

    await act(async () => {
      render(
        <AppsProvider apps={apps}>
          <div data-testid="sec-tc1">
            <McpAppSection
              {...defaultProps}
              appId={APP_ID}
              appName="Dashboard"
              toolName="archestra__edit_app"
              toolCallId="tc1"
              preloadedResource={preloadedResource}
            />
          </div>
          <div data-testid="sec-tc2">
            <McpAppSection
              {...defaultProps}
              appId={APP_ID}
              appName="Dashboard"
              toolName="archestra__edit_app"
              toolCallId="tc2"
              preloadedResource={preloadedResource}
            />
          </div>
        </AppsProvider>,
      );
    });

    // The latest render (tc2) shows the single live instance; the older is a pill.
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(
      screen.getByTestId("sec-tc2").querySelector("iframe"),
    ).toBeInTheDocument();

    // Clicking the older render's pill moves the single instance under it and
    // collapses the newer one — still exactly one open.
    await act(async () => {
      await user.click(
        within(screen.getByTestId("sec-tc1")).getByRole("button", {
          name: "Dashboard",
        }),
      );
    });
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(
      screen.getByTestId("sec-tc1").querySelector("iframe"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sec-tc2").querySelector("iframe"),
    ).not.toBeInTheDocument();
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

  it("shows the error message while expanded and never mounts the runtime", async () => {
    const user = userEvent.setup();

    await act(async () => {
      render(
        <AppsProvider apps={[]}>
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

    // Apps default open, so the unavailable message shows immediately — but
    // the runtime never mounts (it would 404).
    const pill = screen.getByRole("button", { name: "Dashboard" });
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();

    // Collapsing via the pill hides the message like any other app content.
    await act(async () => {
      await user.click(pill);
    });
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();
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

  it("degrades silently for a third-party app when the UI resource can't be read", async () => {
    // A third-party tool advertises a ui:// resource its upstream server can't
    // serve (e.g. -32601 Method not found). The tool result is shown regardless,
    // so the failed app load must fold away rather than show a "Failed to load
    // app" card. defaultProps is an agent (third-party) render — no appId.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("MCP error -32601: Method not found"));

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          toolDetails={<div data-testid="tool-details">details</div>}
        />,
      );
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // Flush the rejection handler + re-render.
    await act(async () => {});

    expect(screen.queryByText(/failed to load app/i)).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    // The app folded away, but its tool-call details stay inspectable.
    expect(screen.getByTestId("tool-details")).toBeInTheDocument();

    fetchSpy.mockRestore();
  });

  it("shows the error for an owned app when the UI resource can't be read", async () => {
    // Owned (Archestra-authored) apps do not degrade: a load failure is an
    // authoring bug the author needs to see, so the error card stays.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network error"));

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          appId="11111111-1111-1111-1111-111111111111"
        />,
      );
    });

    await vi.waitFor(() => {
      expect(screen.getByText(/failed to load app/i)).toBeInTheDocument();
    });

    fetchSpy.mockRestore();
  });
});
