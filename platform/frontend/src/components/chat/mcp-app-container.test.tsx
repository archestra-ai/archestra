import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authPermissionState } = vi.hoisted(() => ({
  authPermissionState: { granted: false },
}));

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

vi.mock("@/lib/config/config", async (importOriginal) => ({
  // Partial: the auth client reads this module's default export at import
  // time, and it is reachable from here through the recorder's organization
  // query — a factory without it takes the whole suite down on load.
  ...(await importOriginal<typeof import("@/lib/config/config")>()),
  getMcpSandboxBaseUrl: () => ({
    baseUrl: "http://127.0.0.1:9000",
    hasCrossOrigin: true,
  }),
}));

vi.mock("@/lib/config/config.query");

// The app pill renders the owned app's icon through McpCatalogIcon, which reads
// the deployment's branding logo from a query; this suite renders without a
// QueryClient, so use the canonical mock.
vi.mock("@/lib/hooks/use-app-name");

// Avoid pulling the real auth client / app query (and their network deps) into
// the test; the edit pencil is covered by app-frame.test.tsx.
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: authPermissionState.granted }),
  useSession: () => ({ data: undefined }),
}));

vi.mock("@/lib/app.query", () => ({
  useApp: vi.fn(() => ({ data: undefined })),
  useDeleteApp: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock("@/lib/apps/use-app-access", () => ({
  useAppAccess: vi.fn(() => ({ canEdit: true, isPending: false })),
  appActionDisabledReason: ({ access }: { access: { canEdit: boolean } }) =>
    access.canEdit ? undefined : "Only an admin can change this org-wide app",
}));

// Stub the inline settings form: it pulls the environment/teams/auth query
// chains, which aren't this suite's concern (covered by their own tests). Here
// we only assert the panel chrome toggles it from the gear. The form owns the
// whole (left-nav) dialog and its Cancel/Save footer, so the stub mirrors that.
vi.mock("@/components/mcp-app/app-settings-form", () => ({
  AppSettingsForm: ({
    onOpenChange,
  }: {
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid="settings-form">
      <button type="button" onClick={() => onOpenChange(false)}>
        Cancel
      </button>
      <button type="submit">Save</button>
    </div>
  ),
}));

// ── Import component under test after mocks ───────────────────────────────────

import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  clearMcpAppGuestState,
  McpAppRuntime,
} from "@/components/mcp-app/mcp-app-view";
import { useApp } from "@/lib/app.query";
import { useAppAccess } from "@/lib/apps/use-app-access";
import {
  clearAllAppDiagnostics,
  reportAppDiagnostic,
} from "@/lib/chat/app-diagnostics-store";
import { useFeature } from "@/lib/config/config.query";
import { AppsProvider, type PanelApp, useApps } from "./apps-context";
import { McpAppSection } from "./mcp-app-container";

const mockUseApp = vi.mocked(useApp);
const mockUseAppAccess = vi.mocked(useAppAccess);

// `vi.clearAllMocks()` clears recorded calls but keeps a `mockReturnValue` an
// earlier test set, so re-seed the default here: one test's owned-app fixture
// (a name, a fullscreen-by-default flag) must not leak into the next.
beforeEach(() => {
  authPermissionState.granted = false;
  clearMcpAppGuestState();
  mockUseApp.mockReturnValue({ data: undefined } as ReturnType<typeof useApp>);
  mockUseAppAccess.mockReturnValue({
    canEdit: true,
    isPending: false,
  } as ReturnType<typeof useAppAccess>);
});

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

  it("offers the host's own way into fullscreen, without the app asking for it", async () => {
    // The bridge is stubbed, so nothing here ever calls
    // `ui/request-display-mode` — which is exactly the case that used to leave
    // an app with no way to fill the surface.
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="panel"
          preloadedResource={preloadedResource}
        />,
      );
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Enter fullscreen" }),
    );

    expect(
      screen.getByRole("button", { name: "Exit fullscreen" }),
    ).toBeInTheDocument();
  });

  it("opens an app straight into fullscreen when that is its saved default", async () => {
    mockUseApp.mockReturnValue({
      data: { name: "Ops Board", openInFullscreen: true },
    } as ReturnType<typeof useApp>);

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="panel"
          appId="11111111-1111-1111-1111-111111111111"
          preloadedResource={preloadedResource}
        />,
      );
    });

    expect(
      screen.getByRole("button", { name: "Exit fullscreen" }),
    ).toBeInTheDocument();
  });

  it("does not re-enter fullscreen after the viewer leaves it", async () => {
    mockUseApp.mockReturnValue({
      data: { name: "Ops Board", openInFullscreen: true },
    } as ReturnType<typeof useApp>);

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="panel"
          appId="11111111-1111-1111-1111-111111111111"
          preloadedResource={preloadedResource}
        />,
      );
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Exit fullscreen" }),
    );

    // The default seeds the first render only; re-applying it here would trap
    // the viewer in fullscreen.
    expect(
      screen.getByRole("button", { name: "Enter fullscreen" }),
    ).toBeInTheDocument();
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

  it("shows an exit-fullscreen button in the panel top bar when the app goes fullscreen", async () => {
    // Regression: the panel surface renders no hover overlay, so when a
    // panel-hosted app requested fullscreen via the SDK there was no way back
    // out (Escape is swallowed by iframe focus) short of reloading the page.
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
          surface="panel"
          preloadedResource={preloadedResource}
        />,
      );
    });

    expect(
      screen.queryByRole("button", { name: /exit fullscreen/i }),
    ).not.toBeInTheDocument();

    const bridge = bridgeInstances[0];
    await act(async () => {
      await bridge.onrequestdisplaymode({ mode: "fullscreen" });
    });

    const exitButton = screen.getByRole("button", {
      name: /exit fullscreen/i,
    });

    await act(async () => {
      await user.click(exitButton);
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

describe("McpAppContainer sandbox timeout recovery", () => {
  const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
  const SANDBOX_ORIGIN = "http://127.0.0.1:9000";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderTimedApp(connect: () => Promise<void>) {
    const { AppBridge } = await import(
      "@modelcontextprotocol/ext-apps/app-bridge"
    );
    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          preloadedResource={preloadedResource}
        />,
      );
    });

    const iframe = document.querySelector("iframe");
    if (!iframe) throw new Error("iframe did not mount");
    const bridge = (AppBridge as ReturnType<typeof vi.fn>).mock.instances.at(
      -1,
    ) as { connect: ReturnType<typeof vi.fn> } | undefined;
    if (!bridge) throw new Error("bridge did not initialize");
    bridge.connect.mockImplementation(connect);
    return { bridge, iframe };
  }

  function dispatchReady(iframe: HTMLIFrameElement, origin: string) {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin,
        data: { method: SANDBOX_PROXY_READY },
      }),
    );
  }

  it("clears a timeout after the same sandbox connects late", async () => {
    let resolveConnect: () => void = () => {};
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const { bridge, iframe } = await renderTimedApp(() => connectPromise);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => dispatchReady(iframe, "https://invalid.example"));
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => dispatchReady(iframe, SANDBOX_ORIGIN));
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await act(async () => {
      resolveConnect();
      await connectPromise;
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps an error visible when the late connection fails", async () => {
    const { iframe } = await renderTimedApp(() =>
      Promise.reject(new Error("late connection failed")),
    );

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await act(async () => {
      dispatchReady(iframe, SANDBOX_ORIGIN);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
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
    // A settled 404 — the single answer the API gives both for a deleted app
    // and for a healthy one the viewer holds no grant for. It does not tell the
    // two apart, so neither may the message.
    mockUseApp.mockReturnValue({ data: null, isSuccess: true } as ReturnType<
      typeof useApp
    >);
  });

  it("says the app is unavailable without claiming it was deleted, and never mounts the runtime", async () => {
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
    expect(
      screen.getByText(/Dashboard isn't available to you/i),
    ).toBeInTheDocument();
    // The regression this guards: a healthy app that is merely not shared with
    // the viewer — the ordinary case, since apps built in chat are personal and
    // sharing a chat never shares them — was reported as gone, sending people
    // after a fault that does not exist.
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();
    // Instead it names the likely cause and the one action that resolves it.
    expect(
      screen.getByText(/sharing a chat doesn't share the apps inside it/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/ask its owner to share it with your team/i),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();

    // Collapsing via the pill hides the message like any other app content.
    await act(async () => {
      await user.click(pill);
    });
    expect(
      screen.queryByText(/isn't available to you/i),
    ).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("still shows the message while the right panel is hosting apps", async () => {
    // A live render defers to the panel whenever there is a portal target. An
    // unavailable app must not: it is filtered out of the panel's list, so
    // deferring renders it nowhere and the pill is left explaining nothing.
    function OpenPanel() {
      const { setPortalTarget } = useApps();
      useEffect(() => {
        setPortalTarget(document.createElement("div"));
      }, [setPortalTarget]);
      return null;
    }

    await act(async () => {
      render(
        <AppsProvider apps={[]}>
          <OpenPanel />
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

    expect(
      screen.getByText(/Dashboard isn't available to you/i),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
  });
});

describe("McpAppSection owned-app pill icon", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the app's own icon on the pill, and the generic glyph without one", async () => {
    mockUseApp.mockReturnValue({
      data: { id: APP_ID, name: "Dashboard", icon: "\u{1F680}", enabled: true },
      isSuccess: true,
    } as unknown as ReturnType<typeof useApp>);

    const { unmount } = await act(async () =>
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
      ),
    );

    expect(
      within(screen.getByRole("button", { name: "Dashboard" })).getByText(
        "\u{1F680}",
      ),
    ).toBeInTheDocument();
    unmount();

    // An app with no icon keeps the generic app glyph rather than rendering an
    // empty slot — the same fallback every other Apps surface uses.
    mockUseApp.mockReturnValue({
      data: { id: APP_ID, name: "Dashboard", icon: null, enabled: true },
      isSuccess: true,
    } as unknown as ReturnType<typeof useApp>);

    await act(async () =>
      render(
        <AppsProvider apps={[]}>
          <McpAppSection
            {...defaultProps}
            appId={APP_ID}
            appName="Dashboard"
            toolCallId="tc2"
            preloadedResource={preloadedResource}
          />
        </AppsProvider>,
      ),
    );

    expect(
      within(screen.getByRole("button", { name: "Dashboard" })).queryByText(
        "\u{1F680}",
      ),
    ).not.toBeInTheDocument();
  });
});

describe("McpAppSection owned-app panel chrome", () => {
  const APP_ID = "947051c7-ea8e-48ed-8077-a3cc904d9d61";
  const SECOND_APP_ID = "6bc05a26-0ffc-4131-a073-c874701d2b91";

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAppDiagnostics();
    authPermissionState.granted = true;
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

  function OwnedPanelHost({ apps }: { apps: PanelApp[] }) {
    const { panelToolCallId, setPanelApp } = useApps();
    const panelApp = apps.find((app) => app.toolCallId === panelToolCallId);

    return (
      <>
        <button type="button" onClick={() => setPanelApp("tc1")}>
          Switch to first app
        </button>
        <div data-testid="panel-app">{panelApp?.appId ?? "none"}</div>
        {panelApp?.appId ? (
          <McpAppSection
            {...defaultProps}
            surface="panel"
            appId={panelApp.appId}
            toolCallId={panelApp.toolCallId}
            uiResourceUri={panelApp.uiResourceUri}
            preloadedResource={preloadedResource}
          />
        ) : null}
      </>
    );
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

  it("disables app settings with the scope reason when the viewer cannot edit the app", async () => {
    mockUseAppAccess.mockReturnValue({
      canEdit: false,
      isPending: false,
    } as ReturnType<typeof useAppAccess>);

    await renderOwnedPanel();

    const settings = screen.getByRole("button", { name: /^settings$/i });
    expect(settings).toHaveAttribute("aria-disabled", "true");
    expect(
      document.getElementById(
        settings.getAttribute("aria-describedby") as string,
      ),
    ).toHaveTextContent("Only an admin can change this org-wide app");
    expect(screen.queryByTestId("settings-form")).not.toBeInTheDocument();
  });

  it("closes settings when a newly rendered app takes the panel", async () => {
    const user = userEvent.setup();
    const apps: PanelApp[] = [
      {
        toolCallId: "tc1",
        label: "First App",
        uiResourceUri: "ui://first/app.html",
        appId: APP_ID,
        createdAt: 1,
      },
      {
        toolCallId: "tc2",
        label: "Second App",
        uiResourceUri: "ui://second/app.html",
        appId: SECOND_APP_ID,
        createdAt: 2,
      },
    ];
    mockUseApp.mockImplementation(
      (appId) =>
        ({ data: { id: appId, name: "Panel App" } }) as ReturnType<
          typeof useApp
        >,
    );

    const { rerender } = render(
      <AppsProvider apps={[apps[0]]}>
        <OwnedPanelHost apps={apps} />
      </AppsProvider>,
    );
    await user.click(screen.getByRole("button", { name: /^settings$/i }));
    expect(screen.getByTestId("settings-form")).toBeInTheDocument();

    rerender(
      <AppsProvider apps={apps}>
        <OwnedPanelHost apps={apps} />
      </AppsProvider>,
    );
    expect(screen.getByTestId("panel-app")).toHaveTextContent(SECOND_APP_ID);
    expect(screen.queryByTestId("settings-form")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Switch to first app" }),
    );
    expect(screen.getByTestId("panel-app")).toHaveTextContent(APP_ID);
    expect(screen.queryByTestId("settings-form")).not.toBeInTheDocument();
  });
});

describe("McpAppRuntime auth banner recovery", () => {
  const AUTH_URL = "http://localhost:3000/mcp/registry?install=cat_test";
  type CapturedBridge = {
    oncalltool:
      | ((
          params: { name: string },
          extra: { signal: AbortSignal },
        ) => Promise<unknown>)
      | null;
  };
  type PendingToolCall = {
    toolName: string;
    respond: (result: unknown) => void;
    reject: (error: unknown) => void;
  };

  let bridges: CapturedBridge[];
  let pendingToolCalls: PendingToolCall[];
  let restoreFetch: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    bridges = [];
    pendingToolCalls = [];

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
      this.connect = vi.fn().mockResolvedValue(undefined);
      this.sendSandboxResourceReady = vi.fn().mockResolvedValue(undefined);
      this.sendToolInput = vi.fn().mockResolvedValue(undefined);
      this.sendToolInputPartial = vi.fn().mockResolvedValue(undefined);
      this.sendToolResult = vi.fn().mockResolvedValue(undefined);
      this.setHostContext = vi.fn();
      this.teardownResource = vi.fn().mockResolvedValue(undefined);
      bridges.push(this as CapturedBridge);
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON-RPC request body");
        }
        const request = JSON.parse(init.body) as {
          id: number;
          params: { name: string };
        };
        return new Promise<Response>((resolve, reject) => {
          pendingToolCalls.push({
            toolName: request.params.name,
            respond: (result) =>
              resolve(
                Response.json({ jsonrpc: "2.0", id: request.id, result }),
              ),
            reject,
          });
        });
      });
    restoreFetch = () => fetchSpy.mockRestore();
  });

  afterEach(() => restoreFetch());

  it("clears a same-tool auth refusal after a newer success", async () => {
    const bridge = await renderRuntime();
    const authCall = callTool(bridge, "search");
    await settleToolCall(0, authRequiredResult(), authCall);
    expect(screen.getByRole("link")).toHaveAttribute("href", AUTH_URL);

    const success = successfulResult();
    const successCall = callTool(bridge, "search");
    const outcome = await settleToolCall(1, success, successCall);

    expect(outcome).toStrictEqual(success);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps a refusal through ordinary errors and other-tool successes", async () => {
    const bridge = await renderRuntime();
    const authCall = callTool(bridge, "search");
    await settleToolCall(0, authRequiredResult(), authCall);

    const errorCall = callTool(bridge, "search");
    await settleToolCall(1, ordinaryErrorResult(), errorCall);
    expect(screen.getByRole("link")).toHaveAttribute("href", AUTH_URL);

    const otherSuccess = callTool(bridge, "other");
    await settleToolCall(2, successfulResult(), otherSuccess);
    expect(screen.getByRole("link")).toHaveAttribute("href", AUTH_URL);
  });

  it("does not let newer ordinary failures suppress older auth refusals", async () => {
    const user = userEvent.setup();
    const bridge = await renderRuntime();

    const olderAuth = callTool(bridge, "search");
    const newerError = callTool(bridge, "search");
    await settleToolCall(1, ordinaryErrorResult(), newerError);
    await settleToolCall(0, authRequiredResult(), olderAuth);
    expect(screen.getByRole("link")).toHaveAttribute("href", AUTH_URL);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    const secondOlderAuth = callTool(bridge, "search");
    const newerRejected = callTool(bridge, "search");
    const requestError = new Error("Request failed");
    expect(await rejectToolCall(3, requestError, newerRejected)).toBe(
      requestError,
    );
    await settleToolCall(2, authRequiredResult(), secondOlderAuth);
    expect(screen.getByRole("link")).toHaveAttribute("href", AUTH_URL);
  });

  it("refreshes identical-refusal ordering without replacing the banner", async () => {
    const bridge = await renderRuntime();
    const firstAuth = callTool(bridge, "search");
    await settleToolCall(0, authRequiredResult(), firstAuth);
    const firstLink = screen.getByRole("link");

    const olderSuccess = callTool(bridge, "search");
    const newerRepeatedAuth = callTool(bridge, "search");
    await settleToolCall(2, authRequiredResult(), newerRepeatedAuth);
    expect(screen.getByRole("link")).toBe(firstLink);
    expect(screen.getAllByRole("link")).toHaveLength(1);

    await settleToolCall(1, successfulResult(), olderSuccess);
    expect(screen.getByRole("link")).toBe(firstLink);
  });

  it("orders both out-of-order completion directions by call generation", async () => {
    const bridge = await renderRuntime();

    const olderAuth = callTool(bridge, "search");
    const newerSuccess = callTool(bridge, "search");
    await settleToolCall(1, successfulResult(), newerSuccess);
    await settleToolCall(0, authRequiredResult(), olderAuth);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    const olderSuccess = callTool(bridge, "search");
    const newerAuth = callTool(bridge, "search");
    await settleToolCall(3, authRequiredResult(), newerAuth);
    await settleToolCall(2, successfulResult(), olderSuccess);
    expect(screen.getByRole("link")).toHaveAttribute("href", AUTH_URL);
  });

  it("ignores a late settlement from a replaced bridge", async () => {
    const rendered = render(runtimeNode("app-1"));
    await vi.waitFor(() => expect(bridges).toHaveLength(1));
    const staleCall = callTool(bridges[0], "search");

    rendered.rerender(runtimeNode("app-2"));
    await vi.waitFor(() => expect(bridges).toHaveLength(2));
    const staleResult = authRequiredResult();
    const outcome = await settleToolCall(0, staleResult, staleCall);

    expect(outcome).toStrictEqual(staleResult);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  async function renderRuntime(): Promise<CapturedBridge> {
    render(runtimeNode("app-1"));
    await vi.waitFor(() => expect(bridges).toHaveLength(1));
    return bridges[0];
  }

  function runtimeNode(appId: string) {
    return (
      <McpAppRuntime
        toolResourceUri="ui://test/app"
        endpoint={{ kind: "app", appId }}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        onSizeChange={vi.fn()}
        onResourceStateChange={vi.fn()}
        preloadedResource={preloadedResource}
      />
    );
  }

  function callTool(bridge: CapturedBridge, name: string): Promise<unknown> {
    if (!bridge.oncalltool)
      throw new Error("Bridge tool callback not installed");
    // The real AppBridge always passes the per-request handler extra; the
    // handler threads its abort signal into the gateway fetch.
    return bridge.oncalltool(
      { name },
      { signal: new AbortController().signal },
    );
  }

  async function settleToolCall(
    index: number,
    result: unknown,
    call: Promise<unknown>,
  ): Promise<unknown> {
    let outcome: unknown;
    await act(async () => {
      pendingToolCalls[index].respond(result);
      outcome = await call;
    });
    return outcome;
  }

  async function rejectToolCall(
    index: number,
    error: unknown,
    call: Promise<unknown>,
  ): Promise<unknown> {
    let rejection: unknown;
    await act(async () => {
      pendingToolCalls[index].reject(error);
      try {
        await call;
      } catch (caught) {
        rejection = caught;
      }
    });
    return rejection;
  }

  function authRequiredResult() {
    return {
      isError: true,
      content: [{ type: "text", text: "Authentication required" }],
      _meta: {
        archestraError: {
          type: "auth_required",
          message: "Authentication required",
          catalogName: "Test catalog",
          catalogId: "cat_test",
          action: "install_mcp_credentials",
          actionUrl: AUTH_URL,
        },
      },
    };
  }

  function successfulResult() {
    return { content: [{ type: "text", text: "ok" }] };
  }

  function ordinaryErrorResult() {
    return {
      isError: true,
      content: [{ type: "text", text: "Tool failed" }],
    };
  }
});

describe("McpAppSection error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a retryable error for a third-party app when the UI resource can't be read", async () => {
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

    expect(screen.getByText(/failed to load app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(
      screen.queryByText("This app rendered nothing to display."),
    ).not.toBeInTheDocument();

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

describe("McpAppSection filter and parameter state preservation on reload", () => {
  const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
  const SANDBOX_ORIGIN = "http://127.0.0.1:9000";

  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpAppGuestState();
  });

  // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
  function installBridgeCollector(bridgeInstances: any[]) {
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
  }

  async function notifySandboxProxyReady(iframe: HTMLIFrameElement) {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          origin: SANDBOX_ORIGIN,
          data: { method: SANDBOX_PROXY_READY },
        }),
      );
    });
  }

  it("forwards captured guest filter/parameter state to the new sandbox on top-left Reload app click", async () => {
    const user = userEvent.setup();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    installBridgeCollector(bridgeInstances);

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="panel"
          preloadedResource={preloadedResource}
        />,
      );
    });

    const firstIframe = document.querySelector("iframe");
    if (!firstIframe) throw new Error("initial iframe did not mount");
    await notifySandboxProxyReady(firstIframe);

    expect(bridgeInstances).toHaveLength(1);
    expect(bridgeInstances[0].sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.not.objectContaining({
        restoredState: expect.anything(),
      }),
    );

    const capturedState = {
      controls: {
        "#filter-user": {
          kind: "form",
          tag: "select",
          type: "select-one",
          value: "alice",
          selectedIndex: 2,
          selectedText: "@Alice",
        },
        "#filter-client": {
          kind: "form",
          tag: "select",
          type: "select-one",
          value: "acme",
          selectedIndex: 1,
          selectedText: "acme (4)",
        },
        "#btn-hide-done": {
          kind: "toggle",
          active: true,
        },
      },
      groups: {
        "button.tab|.toolbar": "2|todo|Todo 71",
      },
      localStorage: {
        "archestra-pm-board:hide-done": "1",
      },
      sessionStorage: {},
      urlHash: "#sprint",
      urlSearch: "",
      historyState: null,
    };

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: firstIframe.contentWindow,
          origin: SANDBOX_ORIGIN,
          data: {
            type: "mcp-apps:state-sync",
            state: capturedState,
          },
        }),
      );
    });

    // Click the top-left reload icon button in the panel header
    const reloadButton = screen.getByRole("button", { name: /reload app/i });
    await act(async () => {
      await user.click(reloadButton);
    });

    const reloadedIframe = document.querySelector("iframe");
    if (!reloadedIframe) throw new Error("reloaded iframe did not mount");
    await notifySandboxProxyReady(reloadedIframe);

    expect(bridgeInstances).toHaveLength(2);
    expect(bridgeInstances[1].sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.objectContaining({
        html: preloadedResource.html,
        restoredState: capturedState,
      }),
    );
  });

  it("preserves guest filter state across remounts of the same app instance without leaking to other tool-call instances or resources", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    installBridgeCollector(bridgeInstances);

    const { unmount } = render(
      <AppsProvider
        apps={[
          {
            toolCallId: "tc-1",
            label: "First Instance",
            uiResourceUri: defaultProps.uiResourceUri,
            createdAt: 0,
          },
        ]}
      >
        <McpAppSection
          {...defaultProps}
          toolCallId="tc-1"
          surface="inline"
          preloadedResource={preloadedResource}
        />
      </AppsProvider>,
    );

    const inlineIframe = document.querySelector("iframe");
    if (!inlineIframe) throw new Error("inline iframe did not mount");
    await notifySandboxProxyReady(inlineIframe);

    const syncedState = {
      controls: {
        "#filter-user": {
          kind: "form",
          tag: "select",
          type: "select-one",
          value: "user-1",
        },
      },
    };

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: inlineIframe.contentWindow,
          origin: SANDBOX_ORIGIN,
          data: {
            type: "mcp-apps:state-sync",
            state: syncedState,
          },
        }),
      );
    });

    unmount();

    // Mounting the same toolCallId on the panel surface restores the state
    const { unmount: unmountPanel } = render(
      <McpAppSection
        {...defaultProps}
        toolCallId="tc-1"
        surface="panel"
        preloadedResource={preloadedResource}
      />,
    );
    const panelIframe = document.querySelector("iframe");
    if (!panelIframe) throw new Error("panel iframe did not mount");
    await notifySandboxProxyReady(panelIframe);

    expect(bridgeInstances[1].sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.objectContaining({
        restoredState: syncedState,
      }),
    );

    unmountPanel();

    // A separate tool-call render (tc-2) of the SAME resource URI does not inherit tc-1's state
    const { unmount: unmountSecondInstance } = render(
      <McpAppSection
        {...defaultProps}
        toolCallId="tc-2"
        surface="panel"
        preloadedResource={preloadedResource}
      />,
    );
    const secondInstanceIframe = document.querySelector("iframe");
    if (!secondInstanceIframe)
      throw new Error("second instance iframe did not mount");
    await notifySandboxProxyReady(secondInstanceIframe);

    expect(bridgeInstances[2].sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.not.objectContaining({
        restoredState: expect.anything(),
      }),
    );

    unmountSecondInstance();

    // Mounting a different app resource URI does not inherit the first app's state
    render(
      <McpAppSection
        {...defaultProps}
        toolCallId="tc-1"
        uiResourceUri="resource://test-server/other-ui"
        surface="panel"
        preloadedResource={preloadedResource}
      />,
    );
    const otherIframe = document.querySelector("iframe");
    if (!otherIframe) throw new Error("other iframe did not mount");
    await notifySandboxProxyReady(otherIframe);

    expect(bridgeInstances[3].sendSandboxResourceReady).toHaveBeenCalledWith(
      expect.not.objectContaining({
        restoredState: expect.anything(),
      }),
    );
  });

  it("guestStateBootstrap captures and restores asynchronously populated select filters, tabs, toggles, and storage while ignoring modal inputs", async () => {
    const proxyHtml = readFileSync(
      join(__dirname, "../../../../backend/src/static/mcp-sandbox-proxy.html"),
      "utf-8",
    );
    const bootstrapStart = proxyHtml.indexOf(
      "function guestStateBootstrap(restored)",
    );
    const bootstrapEnd = proxyHtml.indexOf(
      "function buildStatePreservationScript(restoredState)",
    );
    const bootstrapFnSource = `(${proxyHtml.slice(bootstrapStart, bootstrapEnd).trim()})`;
    const runBootstrap = vm.runInThisContext(bootstrapFnSource) as (
      restored: Record<string, unknown> | null,
    ) => void;

    // 1. Mount an embedded iframe to isolate window/document listeners
    const hostFrame = document.createElement("iframe");
    document.body.appendChild(hostFrame);
    const guestWin = hostFrame.contentWindow as Window & typeof globalThis;
    const guestDoc = hostFrame.contentDocument as Document;

    const syncedPayloads: Record<string, unknown>[] = [];
    const onParentMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        state?: Record<string, unknown>;
      } | null;
      if (data?.type === "mcp-apps:state-sync" && data.state) {
        syncedPayloads.push(data.state);
      }
    };
    window.addEventListener("message", onParentMessage);

    try {
      const renderBoardMarkup = (doc: Document) => {
        doc.body.innerHTML = `
          <div class="toolbar">
            <button class="tab" data-list="archive">Archive</button>
            <button class="tab active" data-list="sprint">Sprint</button>
            <button class="tab" data-list="todo">Todo</button>
          </div>
          <div class="subbar">
            <select id="filter-user" class="filter-select"><option value="">All</option></select>
            <select id="filter-client" class="filter-select"><option value="">All clients</option></select>
            <button id="btn-hide-done" class="filter-toggle" aria-pressed="false">Hide done</button>
          </div>
          <div class="modal-backdrop" id="modal-task">
            <input id="task-title" value="draft title that must not persist" />
          </div>
        `;
      };

      const wireBoardEvents = (doc: Document) => {
        const tabs = Array.from(doc.querySelectorAll(".tab[data-list]"));
        for (const tab of tabs) {
          tab.addEventListener("click", () => {
            for (const other of tabs) other.classList.remove("active");
            tab.classList.add("active");
          });
        }
        const hideDoneBtn = doc.getElementById("btn-hide-done");
        hideDoneBtn?.addEventListener("click", () => {
          const next = hideDoneBtn.getAttribute("aria-pressed") !== "true";
          hideDoneBtn.setAttribute("aria-pressed", String(next));
          hideDoneBtn.classList.toggle("active", next);
        });
      };

      const populateAsyncSelects = (doc: Document) => {
        const userSelect = doc.getElementById(
          "filter-user",
        ) as HTMLSelectElement;
        userSelect.innerHTML =
          '<option value="">All</option><option value="__unassigned__">Unassigned</option><option value="alice">@Alice</option><option value="bob">@Bob</option>';
        const clientSelect = doc.getElementById(
          "filter-client",
        ) as HTMLSelectElement;
        clientSelect.innerHTML =
          '<option value="">All clients</option><option value="acme">acme (4)</option>';
      };

      // Run initial mount in guest context
      renderBoardMarkup(guestDoc);
      wireBoardEvents(guestDoc);
      vm.runInNewContext(`(${bootstrapFnSource})(null)`, {
        window: guestWin,
        document: guestDoc,
        Element: guestWin.Element,
        MutationObserver: guestWin.MutationObserver,
        Event: guestWin.Event,
        setTimeout: guestWin.setTimeout.bind(guestWin),
        clearTimeout: guestWin.clearTimeout.bind(guestWin),
        Object,
        Array,
        String,
        Number,
        JSON,
        CSS: guestWin.CSS,
      });

      populateAsyncSelects(guestDoc);

      // User selects @Alice in #filter-user, acme in #filter-client, clicks Todo tab & Hide done
      const userSelect = guestDoc.getElementById(
        "filter-user",
      ) as HTMLSelectElement;
      userSelect.value = "alice";
      userSelect.dispatchEvent(new guestWin.Event("change", { bubbles: true }));

      const clientSelect = guestDoc.getElementById(
        "filter-client",
      ) as HTMLSelectElement;
      clientSelect.value = "acme";
      clientSelect.dispatchEvent(
        new guestWin.Event("change", { bubbles: true }),
      );

      const todoTab = guestDoc.querySelector(
        '.tab[data-list="todo"]',
      ) as HTMLButtonElement;
      todoTab.click();

      const hideDoneBtn = guestDoc.getElementById(
        "btn-hide-done",
      ) as HTMLButtonElement;
      hideDoneBtn.click();

      guestWin.localStorage.setItem("archestra-pm-board:hide-done", "1");

      // Wait for debounced state-sync postMessage
      await new Promise((r) => setTimeout(r, 80));
      expect(syncedPayloads.length).toBeGreaterThan(0);
      const latestSnapshot = syncedPayloads[syncedPayloads.length - 1];
      const controls = latestSnapshot.controls as Record<
        string,
        Record<string, unknown>
      >;
      expect(controls["#filter-user"]).toMatchObject({
        kind: "form",
        tag: "select",
        value: "alice",
      });
      expect(controls["#filter-client"]).toMatchObject({
        kind: "form",
        tag: "select",
        value: "acme",
      });
      expect(controls["#task-title"]).toBeUndefined();

      // 2. Simulate reload in a fresh iframe with only initial <option value="">All</option>
      const reloadFrame = document.createElement("iframe");
      document.body.appendChild(reloadFrame);
      const reloadWin = reloadFrame.contentWindow as Window & typeof globalThis;
      const reloadDoc = reloadFrame.contentDocument as Document;

      try {
        renderBoardMarkup(reloadDoc);
        wireBoardEvents(reloadDoc);

        let filterUserChangedValue = "";
        reloadDoc
          .getElementById("filter-user")
          ?.addEventListener("change", (e) => {
            filterUserChangedValue = (e.target as HTMLSelectElement).value;
          });

        vm.runInNewContext(
          `(${bootstrapFnSource})(${JSON.stringify(latestSnapshot)})`,
          {
            window: reloadWin,
            document: reloadDoc,
            Element: reloadWin.Element,
            MutationObserver: reloadWin.MutationObserver,
            Event: reloadWin.Event,
            setTimeout: reloadWin.setTimeout.bind(reloadWin),
            clearTimeout: reloadWin.clearTimeout.bind(reloadWin),
            Object,
            Array,
            String,
            Number,
            JSON,
            CSS: reloadWin.CSS,
          },
        );

        // Storage is restored synchronously before any guest script runs
        expect(
          reloadWin.localStorage.getItem("archestra-pm-board:hide-done"),
        ).toBe("1");

        // Simulate MCP App handshake / initial tool-result arriving, then async option population
        reloadWin.dispatchEvent(
          new reloadWin.MessageEvent("message", {
            data: {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: {},
            },
          }),
        );

        // Populate #filter-user and #filter-client asynchronously (as pm-board.ts does after connect)
        populateAsyncSelects(reloadDoc);
        await new Promise((r) => setTimeout(r, 80));

        expect(
          (reloadDoc.getElementById("filter-user") as HTMLSelectElement).value,
        ).toBe("alice");
        expect(filterUserChangedValue).toBe("alice");
        expect(
          (reloadDoc.getElementById("filter-client") as HTMLSelectElement)
            .value,
        ).toBe("acme");
        expect(
          reloadDoc
            .querySelector('.tab[data-list="todo"]')
            ?.classList.contains("active"),
        ).toBe(true);
        expect(
          reloadDoc
            .getElementById("btn-hide-done")
            ?.getAttribute("aria-pressed"),
        ).toBe("true");
      } finally {
        reloadFrame.remove();
      }
      void runBootstrap;
    } finally {
      window.removeEventListener("message", onParentMessage);
      hostFrame.remove();
    }
  });

  it("guestStateBootstrap handles controlled React inputs, async toggle mutations, multi-pass select resets, sibling independent toggles, and batched multi-select options", async () => {
    const proxyHtml = readFileSync(
      join(__dirname, "../../../../backend/src/static/mcp-sandbox-proxy.html"),
      "utf-8",
    );
    const bootstrapStart = proxyHtml.indexOf(
      "function guestStateBootstrap(restored)",
    );
    const bootstrapEnd = proxyHtml.indexOf(
      "function buildStatePreservationScript(restoredState)",
    );
    const bootstrapFnSource = `(${proxyHtml.slice(bootstrapStart, bootstrapEnd).trim()})`;

    const syncedPayloads: Record<string, unknown>[] = [];
    const onParentMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        state?: Record<string, unknown>;
      } | null;
      if (data?.type === "mcp-apps:state-sync" && data.state) {
        syncedPayloads.push(data.state);
      }
    };
    window.addEventListener("message", onParentMessage);

    // 1. Verify async toggle capture (aria-pressed updated 50ms after click) +
    // sibling independent [aria-pressed] toggles where one defaults to "true"
    const captureFrame = document.createElement("iframe");
    document.body.appendChild(captureFrame);
    const captureWin = captureFrame.contentWindow as Window & typeof globalThis;
    const captureDoc = captureFrame.contentDocument as Document;

    try {
      captureDoc.body.innerHTML = `
        <div class="subbar">
          <button id="toggle-default-on" aria-pressed="true">Hide archive</button>
          <button id="toggle-async" aria-pressed="false">Async filter</button>
        </div>
      `;
      const defaultOnBtn = captureDoc.getElementById(
        "toggle-default-on",
      ) as HTMLButtonElement;
      defaultOnBtn.addEventListener("click", () => {
        const next = defaultOnBtn.getAttribute("aria-pressed") !== "true";
        defaultOnBtn.setAttribute("aria-pressed", String(next));
      });
      const asyncBtn = captureDoc.getElementById(
        "toggle-async",
      ) as HTMLButtonElement;
      asyncBtn.addEventListener("click", () => {
        captureWin.setTimeout(() => {
          asyncBtn.setAttribute("aria-pressed", "true");
        }, 50);
      });

      vm.runInNewContext(`(${bootstrapFnSource})(null)`, {
        window: captureWin,
        document: captureDoc,
        Element: captureWin.Element,
        MutationObserver: captureWin.MutationObserver,
        Event: captureWin.Event,
        setTimeout: captureWin.setTimeout.bind(captureWin),
        clearTimeout: captureWin.clearTimeout.bind(captureWin),
        Object,
        Array,
        String,
        Number,
        JSON,
        CSS: captureWin.CSS,
      });

      // Turn off #toggle-default-on (now false) and click #toggle-async (turns true after 50ms)
      defaultOnBtn.click();
      asyncBtn.click();

      await new Promise((r) => setTimeout(r, 100));
      expect(syncedPayloads.length).toBeGreaterThan(0);
      const captured = syncedPayloads[syncedPayloads.length - 1];
      const capturedControls = captured.controls as Record<
        string,
        Record<string, unknown>
      >;
      expect(capturedControls["#toggle-default-on"]).toMatchObject({
        kind: "toggle",
        active: false,
      });
      expect(capturedControls["#toggle-async"]).toMatchObject({
        kind: "toggle",
        active: true,
      });

      // 2. Restore in a fresh iframe with:
      // - #toggle-default-on defaulting to aria-pressed="true" (must restore to "false")
      // - controlled React-like input #search-input with _valueTracker + custom value setter
      // - #single-select that gets rebuilt and reset to "" 50ms after initial restoration
      // - #multi-select whose options ["a", "b"] arrive in two async batches
      const restoreState = {
        controls: {
          "#toggle-default-on": capturedControls["#toggle-default-on"],
          "#toggle-async": {
            kind: "toggle",
            selector: "#toggle-async",
            mode: "aria-pressed",
            active: false,
            isGroup: false,
            label: "Async filter",
          },
          "#search-input": {
            kind: "form",
            selector: "#search-input",
            tag: "input",
            type: "text",
            value: "blue",
          },
          "#single-select": {
            kind: "form",
            selector: "#single-select",
            tag: "select",
            type: "select-one",
            value: "Blue",
            selectedText: "Blue",
          },
          "#delayed-select": {
            kind: "form",
            selector: "#delayed-select",
            tag: "select",
            type: "select-one",
            value: "Blue",
            selectedText: "Blue",
          },
          "#multi-select": {
            kind: "form",
            selector: "#multi-select",
            tag: "select",
            type: "select-multiple",
            value: "a",
            selectedValues: ["a", "b", "c", "d", "e"],
          },
        },
      };

      const reloadFrame = document.createElement("iframe");
      document.body.appendChild(reloadFrame);
      const reloadWin = reloadFrame.contentWindow as Window & typeof globalThis;
      const reloadDoc = reloadFrame.contentDocument as Document;

      try {
        reloadDoc.body.innerHTML = `
          <div class="subbar">
            <button id="toggle-default-on" aria-pressed="true">Hide archive</button>
            <button id="toggle-async" aria-pressed="false">Async filter</button>
            <input id="search-input" type="text" value="" />
            <select id="single-select">
              <option value="">All</option>
              <option value="Blue">Blue</option>
            </select>
            <select id="delayed-select">
              <option value="">All</option>
            </select>
            <select id="multi-select" multiple></select>
          </div>
        `;

        const reloadDefaultOn = reloadDoc.getElementById(
          "toggle-default-on",
        ) as HTMLButtonElement;
        reloadDefaultOn.addEventListener("click", () => {
          const next = reloadDefaultOn.getAttribute("aria-pressed") !== "true";
          reloadDefaultOn.setAttribute("aria-pressed", String(next));
        });

        // Mount real React controlled text input + checkbox inside reloadDoc
        const reactMount = reloadDoc.createElement("div");
        reloadDoc.body.appendChild(reactMount);
        let latestReactChecked = false;
        let latestReactText = "";
        function ControlledGuestForm() {
          const [checked, setChecked] = useState(false);
          const [text, setText] = useState("");
          const [rerenders, setRerenders] = useState(0);
          latestReactChecked = checked;
          latestReactText = text;
          return (
            <div data-rerenders={rerenders}>
              <input
                id="react-checkbox"
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <input
                id="react-text"
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button
                id="react-rerender-btn"
                type="button"
                onClick={() => setRerenders((c) => c + 1)}
              >
                Rerender
              </button>
            </div>
          );
        }
        render(<ControlledGuestForm />, { container: reactMount });
        (restoreState.controls as Record<string, Record<string, unknown>>)[
          "#react-checkbox"
        ] = {
          kind: "form",
          selector: "#react-checkbox",
          tag: "input",
          type: "checkbox",
          value: "on",
          checked: true,
        };
        (restoreState.controls as Record<string, Record<string, unknown>>)[
          "#react-text"
        ] = {
          kind: "form",
          selector: "#react-text",
          tag: "input",
          type: "text",
          value: "blue",
        };

        // Emulate React's controlled input _valueTracker and custom instance setter
        const searchInput = reloadDoc.getElementById(
          "search-input",
        ) as HTMLInputElement & {
          _valueTracker?: {
            getValue: () => string;
            setValue: (v: string) => void;
          };
        };
        const nativeInputDesc = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(searchInput),
          "value",
        );
        let trackedValue = "";
        let reactStateValue = "";
        searchInput._valueTracker = {
          getValue: () => trackedValue,
          setValue: (v: string) => {
            trackedValue = String(v);
          },
        };
        Object.defineProperty(searchInput, "value", {
          configurable: true,
          enumerable: true,
          get() {
            return nativeInputDesc?.get ? nativeInputDesc.get.call(this) : "";
          },
          set(v: string) {
            trackedValue = String(v);
            nativeInputDesc?.set?.call(this, v);
          },
        });
        searchInput.addEventListener("input", () => {
          const currentDomValue = nativeInputDesc?.get
            ? String(nativeInputDesc.get.call(searchInput))
            : "";
          if (searchInput._valueTracker?.getValue() !== currentDomValue) {
            searchInput._valueTracker?.setValue(currentDomValue);
            reactStateValue = currentDomValue;
          }
        });

        vm.runInNewContext(
          `(${bootstrapFnSource})(${JSON.stringify(restoreState)})`,
          {
            window: reloadWin,
            document: reloadDoc,
            Element: reloadWin.Element,
            MutationObserver: reloadWin.MutationObserver,
            Event: reloadWin.Event,
            setTimeout: reloadWin.setTimeout.bind(reloadWin),
            clearTimeout: reloadWin.clearTimeout.bind(reloadWin),
            Object,
            Array,
            String,
            Number,
            JSON,
            CSS: reloadWin.CSS,
          },
        );

        // Trigger initial restore on tool-result
        reloadWin.dispatchEvent(
          new reloadWin.MessageEvent("message", {
            data: {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: {},
            },
          }),
        );

        // Batch 1 for multi-select: only option "a" arrives initially
        const multiSelect = reloadDoc.getElementById(
          "multi-select",
        ) as HTMLSelectElement;
        multiSelect.innerHTML = '<option value="a">A</option>';

        await new Promise((r) => setTimeout(r, 30));

        // Controlled React state updated on initial restore, and survives a React re-render
        expect(reactStateValue).toBe("blue");
        searchInput.value = reactStateValue;
        expect(searchInput.value).toBe("blue");

        const reactCheckboxEl = reloadDoc.getElementById(
          "react-checkbox",
        ) as HTMLInputElement;
        const reactTextEl = reloadDoc.getElementById(
          "react-text",
        ) as HTMLInputElement;
        const reactRerenderBtn = reloadDoc.getElementById(
          "react-rerender-btn",
        ) as HTMLButtonElement;
        expect(latestReactChecked).toBe(true);
        expect(reactCheckboxEl.checked).toBe(true);
        expect(latestReactText).toBe("blue");
        expect(reactTextEl.value).toBe("blue");

        // Trigger an unrelated React re-render and verify both controlled checkbox and text persist
        await act(async () => {
          reactRerenderBtn.click();
        });
        expect(latestReactChecked).toBe(true);
        expect(reactCheckboxEl.checked).toBe(true);
        expect(latestReactText).toBe("blue");
        expect(reactTextEl.value).toBe("blue");

        // Independent sibling toggle that defaulted to "true" was turned off
        expect(reloadDefaultOn.getAttribute("aria-pressed")).toBe("false");

        // Multi-pass initialization: app rebuilds #single-select (resetting to "")
        // and delivers options "b", "c", "d", "e" across 4 more separate async batches (5 total)
        const singleSelect = reloadDoc.getElementById(
          "single-select",
        ) as HTMLSelectElement;
        singleSelect.innerHTML =
          '<option value="">All</option><option value="Blue">Blue</option>';
        singleSelect.value = "";

        // Delayed option population that emits a synthetic bubbling change event
        // before the saved "Blue" selection has ever been applied
        const delayedSelect = reloadDoc.getElementById(
          "delayed-select",
        ) as HTMLSelectElement;
        delayedSelect.innerHTML =
          '<option value="">All</option><option value="Blue">Blue</option>';
        delayedSelect.dispatchEvent(
          new reloadWin.Event("change", { bubbles: true }),
        );

        for (const val of ["b", "c", "d", "e"]) {
          const opt = reloadDoc.createElement("option");
          opt.value = val;
          opt.textContent = val.toUpperCase();
          multiSelect.appendChild(opt);
          await new Promise((r) => setTimeout(r, 15));
        }

        await new Promise((r) => setTimeout(r, 40));

        expect(singleSelect.value).toBe("Blue");
        expect(delayedSelect.value).toBe("Blue");
        const selectedMultiValues = Array.from(multiSelect.options)
          .filter((o) => o.selected)
          .map((o) => o.value);
        expect(selectedMultiValues).toEqual(["a", "b", "c", "d", "e"]);
      } finally {
        reloadFrame.remove();
      }
    } finally {
      window.removeEventListener("message", onParentMessage);
      captureFrame.remove();
    }
  });

  it("does not capture untouched [aria-pressed] toggles or click toggles while startup RPCs are in flight, and restores select filters in the same microtask before paint", async () => {
    const proxyHtml = readFileSync(
      join(__dirname, "../../../../backend/src/static/mcp-sandbox-proxy.html"),
      "utf-8",
    );
    const bootstrapStart = proxyHtml.indexOf(
      "function guestStateBootstrap(restored)",
    );
    const bootstrapEnd = proxyHtml.indexOf(
      "function buildStatePreservationScript(restoredState)",
    );
    const bootstrapFnSource = `(${proxyHtml.slice(bootstrapStart, bootstrapEnd).trim()})`;

    const syncedPayloads: Record<string, unknown>[] = [];
    const onParentMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        state?: Record<string, unknown>;
      } | null;
      if (data?.type === "mcp-apps:state-sync" && data.state) {
        syncedPayloads.push(data.state);
      }
    };
    window.addEventListener("message", onParentMessage);

    const hostFrame = document.createElement("iframe");
    document.body.appendChild(hostFrame);
    const guestWin = hostFrame.contentWindow as Window & typeof globalThis;
    const guestDoc = hostFrame.contentDocument as Document;

    try {
      // Static markup matches pm-board.ts before render(): #toggle-done-btn starts
      // with aria-pressed="false", and render() mutates it to aria-pressed="true".
      guestDoc.body.innerHTML = `
        <div class="subbar">
          <select id="filter-user"><option value="">All</option></select>
          <select id="filter-client" hidden><option value="">All clients</option></select>
          <button id="toggle-done-btn" aria-pressed="false">Hide done</button>
        </div>
      `;

      vm.runInNewContext(`(${bootstrapFnSource})(null)`, {
        window: guestWin,
        document: guestDoc,
        Element: guestWin.Element,
        MutationObserver: guestWin.MutationObserver,
        Event: guestWin.Event,
        setTimeout: guestWin.setTimeout.bind(guestWin),
        clearTimeout: guestWin.clearTimeout.bind(guestWin),
        queueMicrotask: guestWin.queueMicrotask.bind(guestWin),
        Object,
        Array,
        String,
        Number,
        JSON,
        CSS: guestWin.CSS,
      });

      // Initial app render() mutates #toggle-done-btn to aria-pressed="true" and populates selects
      const toggleDoneBtn = guestDoc.getElementById(
        "toggle-done-btn",
      ) as HTMLButtonElement;
      toggleDoneBtn.setAttribute("aria-pressed", "true");
      const filterUser = guestDoc.getElementById(
        "filter-user",
      ) as HTMLSelectElement;
      filterUser.innerHTML =
        '<option value="">All</option><option value="mark">@Mark</option>';

      // User ONLY selects @Mark in #filter-user; never clicks #toggle-done-btn
      filterUser.value = "mark";
      filterUser.dispatchEvent(new guestWin.Event("change", { bubbles: true }));

      await new Promise((r) => setTimeout(r, 40));
      expect(syncedPayloads.length).toBeGreaterThan(0);
      const snapshot = syncedPayloads[syncedPayloads.length - 1];
      const controls = snapshot.controls as Record<string, unknown>;

      // Untouched #toggle-done-btn must NOT be in captured controls
      expect(controls["#toggle-done-btn"]).toBeUndefined();
      expect(controls["#filter-user"]).toMatchObject({
        kind: "form",
        value: "mark",
      });

      // Now simulate reload of an SDK app where a toggle WAS saved, while startup RPCs are in flight
      const reloadSnapshot = {
        controls: {
          "#filter-user": controls["#filter-user"],
          "#toggle-done-btn": {
            kind: "toggle",
            selector: "#toggle-done-btn",
            mode: "aria-pressed",
            active: true,
            isGroup: false,
            label: "Hide done",
          },
        },
      };

      const reloadFrame = document.createElement("iframe");
      document.body.appendChild(reloadFrame);
      const reloadWin = reloadFrame.contentWindow as Window & typeof globalThis;
      const reloadDoc = reloadFrame.contentDocument as Document;

      try {
        (
          reloadWin as unknown as { __ARCHESTRA_APP_CONTEXT__: object }
        ).__ARCHESTRA_APP_CONTEXT__ = {};
        reloadDoc.body.innerHTML = `
          <div class="subbar">
            <select id="filter-user"><option value="">All</option></select>
            <button id="toggle-done-btn" aria-pressed="false">Hide done</button>
          </div>
          <main id="list"></main>
        `;

        let prematureToggleClicks = 0;
        let boardLoaded = false;
        const reloadToggleBtn = reloadDoc.getElementById(
          "toggle-done-btn",
        ) as HTMLButtonElement;
        reloadToggleBtn.addEventListener("click", () => {
          if (!boardLoaded) {
            prematureToggleClicks++;
          }
        });

        const reloadUserSelect = reloadDoc.getElementById(
          "filter-user",
        ) as HTMLSelectElement;
        const renderedFrames: string[] = [];
        const renderBoard = () => {
          const listEl = reloadDoc.getElementById("list");
          if (listEl) {
            listEl.textContent =
              reloadUserSelect.value === "mark"
                ? "Filtered: @Mark (6 tasks)"
                : "Unfiltered: All (90 tasks)";
          }
        };
        reloadUserSelect.addEventListener("change", () => {
          renderBoard();
        });

        vm.runInNewContext(
          `(${bootstrapFnSource})(${JSON.stringify(reloadSnapshot)})`,
          {
            window: reloadWin,
            document: reloadDoc,
            Element: reloadWin.Element,
            MutationObserver: reloadWin.MutationObserver,
            Event: reloadWin.Event,
            setTimeout: reloadWin.setTimeout.bind(reloadWin),
            clearTimeout: reloadWin.clearTimeout.bind(reloadWin),
            queueMicrotask: reloadWin.queueMicrotask.bind(reloadWin),
            Object,
            Array,
            String,
            Number,
            JSON,
            CSS: reloadWin.CSS,
          },
        );

        // Startup RPCs (list_custom_emoji + board_state) are in flight (count = 2)
        reloadWin.dispatchEvent(
          new reloadWin.MessageEvent("message", {
            data: { type: "mcp-apps:rpc-flight", count: 2 },
          }),
        );
        // Initialize handshake response arrives while RPCs are in flight
        reloadWin.dispatchEvent(
          new reloadWin.MessageEvent("message", {
            data: {
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2025-06-18", hostInfo: {} },
            },
          }),
        );

        await new Promise((r) => setTimeout(r, 50));
        // Toggle must NOT be clicked while startup RPCs are in flight on the empty board
        expect(prematureToggleClicks).toBe(0);

        // Now board_state arrives: app sets aria-pressed="true", populates #filter-user, and calls renderBoard()
        boardLoaded = true;
        reloadWin.dispatchEvent(
          new reloadWin.MessageEvent("message", {
            data: { jsonrpc: "2.0", id: 2, result: { content: [] } },
          }),
        );
        reloadToggleBtn.setAttribute("aria-pressed", "true");
        reloadUserSelect.innerHTML =
          '<option value="">All</option><option value="mark">@Mark</option>';
        reloadUserSelect.value = "";
        renderBoard();

        // Record what the DOM looks like at the end of the microtask checkpoint (before macrotask/paint)
        await Promise.resolve();
        await Promise.resolve();
        renderedFrames.push(
          reloadDoc.getElementById("list")?.textContent ?? "",
        );

        expect(reloadUserSelect.value).toBe("mark");
        expect(renderedFrames[0]).toBe("Filtered: @Mark (6 tasks)");
        expect(prematureToggleClicks).toBe(0);
      } finally {
        reloadFrame.remove();
      }
    } finally {
      window.removeEventListener("message", onParentMessage);
      hostFrame.remove();
    }
  });

  it("does not send a duplicate sendSandboxResourceReady when reload resources/read returns identical HTML/CSP, and keeps outgoing iframe visible until mcp-apps:guest-ready", async () => {
    const user = userEvent.setup();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    installBridgeCollector(bridgeInstances);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const transportInstances: any[] = [];
    (PostMessageTransport as ReturnType<typeof vi.fn>).mockImplementation(
      function (this: Record<string, unknown>) {
        this.close = vi.fn().mockReturnValue(Promise.resolve());
        transportInstances.push(this);
      },
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            contents: [
              {
                uri: defaultProps.uiResourceUri,
                text: "<html><body><div>PM Board</div></body></html>",
                _meta: {
                  ui: {
                    csp: { connectDomains: ["https://api.example.com"] },
                    permissions: { clipboardWrite: {} },
                  },
                },
              },
            ],
          },
        }),
      ),
    );

    try {
      await act(async () => {
        render(<McpAppSection {...defaultProps} surface="panel" />);
      });

      const firstIframe = document.querySelector("iframe");
      if (!firstIframe) throw new Error("initial iframe did not mount");
      await notifySandboxProxyReady(firstIframe);

      await vi.waitFor(() => {
        expect(
          bridgeInstances[0].sendSandboxResourceReady,
        ).toHaveBeenCalledTimes(1);
      });
      // Simulate detached onmessage where teardownResource never receives a reply
      bridgeInstances[0].teardownResource.mockReturnValue(
        new Promise(() => {}),
      );

      // Click Reload app (#1)
      const reloadButton = screen.getByRole("button", { name: /reload app/i });
      await act(async () => {
        await user.click(reloadButton);
      });

      // Both outgoing and incoming iframes exist in container during reload transition;
      // incoming iframe is first in DOM order and hidden until mcp-apps:guest-ready.
      const allIframesDuringReload = Array.from(
        document.querySelectorAll("iframe"),
      );
      expect(allIframesDuringReload).toHaveLength(2);
      const intermediateIframe = allIframesDuringReload[0];
      expect(intermediateIframe).not.toBe(firstIframe);
      expect(intermediateIframe.style.opacity).toBe("0");
      expect(firstIframe.isConnected).toBe(true);
      await notifySandboxProxyReady(intermediateIframe);
      bridgeInstances[1].teardownResource.mockReturnValue(
        new Promise(() => {}),
      );
      // Outgoing bridge handlers reject calls immediately so the retained frame
      // cannot run tools during overlap, and teardownResource waits until removal.
      await expect(
        bridgeInstances[0].oncalltool(
          { name: "board_state", arguments: {} },
          {},
        ),
      ).rejects.toThrow("MCP App bridge is closed");
      expect(bridgeInstances[0].teardownResource).not.toHaveBeenCalled();
      expect(transportInstances[0].close).not.toHaveBeenCalled();

      // Click Reload app (#2) before intermediateIframe reveals -> firstIframe
      // stays visible and intermediateIframe is discarded and its transport closed
      // right away without waiting for teardownResource to settle.
      await act(async () => {
        await user.click(reloadButton);
      });

      const allIframesAfterSecondReload = Array.from(
        document.querySelectorAll("iframe"),
      );
      expect(allIframesAfterSecondReload).toHaveLength(2);
      const reloadedIframe = allIframesAfterSecondReload[0];
      expect(reloadedIframe).not.toBe(firstIframe);
      expect(reloadedIframe).not.toBe(intermediateIframe);
      expect(intermediateIframe.isConnected).toBe(false);
      expect(bridgeInstances[1].teardownResource).toHaveBeenCalledTimes(1);
      expect(transportInstances[1].close).toHaveBeenCalledTimes(1);
      expect(firstIframe.isConnected).toBe(true);
      expect(firstIframe.style.opacity).toBe("");
      expect(reloadedIframe.style.opacity).toBe("0");
      expect(bridgeInstances[0].teardownResource).not.toHaveBeenCalled();
      expect(transportInstances[0].close).not.toHaveBeenCalled();

      await notifySandboxProxyReady(reloadedIframe);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      // Must only call sendSandboxResourceReady ONCE on the reloaded bridge even
      // though resources/read returned a fresh csp/permissions object reference.
      expect(bridgeInstances[2].sendSandboxResourceReady).toHaveBeenCalledTimes(
        1,
      );

      // Signal guest-ready from the reloaded iframe -> incoming iframe is revealed
      // and outgoing iframe is torn down and its transport closed immediately.
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: reloadedIframe.contentWindow,
            origin: SANDBOX_ORIGIN,
            data: { type: "mcp-apps:guest-ready" },
          }),
        );
      });

      expect(reloadedIframe.style.opacity).toBe("");
      expect(firstIframe.isConnected).toBe(false);
      expect(bridgeInstances[0].teardownResource).toHaveBeenCalledTimes(1);
      expect(transportInstances[0].close).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("shows immediate button and view reload progress during a delayed reload, waits for resources/read before sending resource ready, and clears progress on mcp-apps:guest-ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime.bind(vi),
    });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    installBridgeCollector(bridgeInstances);

    let resolveReloadFetch: ((response: Response) => void) | null = null;
    let fetchCallCount = 0;
    const makeResourceResponse = (html: string) =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          contents: [
            {
              uri: defaultProps.uiResourceUri,
              text: html,
            },
          ],
        },
      });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        return Promise.resolve(
          makeResourceResponse("<html><body><div>v1</div></body></html>"),
        );
      }
      return new Promise<Response>((resolve) => {
        resolveReloadFetch = resolve;
      });
    });

    try {
      await act(async () => {
        render(<McpAppSection {...defaultProps} surface="panel" />);
      });

      const firstIframe = document.querySelector("iframe");
      if (!firstIframe) throw new Error("initial iframe did not mount");
      await notifySandboxProxyReady(firstIframe);

      await vi.waitFor(() => {
        expect(
          bridgeInstances[0].sendSandboxResourceReady,
        ).toHaveBeenCalledTimes(1);
      });

      const reloadButton = screen.getByRole("button", { name: /reload app/i });
      expect(reloadButton).not.toHaveAttribute("aria-busy");
      expect(
        screen.queryByTestId("mcp-app-reload-indicator"),
      ).not.toBeInTheDocument();

      // Click Reload app while the second resources/read request is held pending
      await act(async () => {
        await user.click(reloadButton);
      });

      // Immediately after click, both button and app view show reload progress
      expect(reloadButton).toHaveAttribute("aria-busy", "true");
      expect(reloadButton).toHaveAttribute("data-state", "active");
      expect(reloadButton.querySelector("svg")).toHaveClass("animate-spin");
      expect(
        screen.getByTestId("mcp-app-reload-indicator"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("progressbar", { name: /reloading app/i }),
      ).toBeInTheDocument();

      const iframesDuringReload = Array.from(
        document.querySelectorAll("iframe"),
      );
      expect(iframesDuringReload).toHaveLength(2);
      const reloadedIframe = iframesDuringReload[0];

      // Even if the incoming sandbox iframe reports proxy-ready before resources/read resolves
      // and remains pending beyond the 2,600ms reveal fallback timeout, sendSandboxResourceReady
      // must NOT be called with stale HTML and the outgoing frame + reload progress must remain visible.
      await notifySandboxProxyReady(reloadedIframe);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2800);
      });
      expect(
        bridgeInstances[1].sendSandboxResourceReady,
      ).not.toHaveBeenCalled();
      expect(firstIframe.isConnected).toBe(true);
      expect(firstIframe.style.opacity).toBe("");
      expect(reloadedIframe.style.opacity).toBe("0");
      expect(reloadButton).toHaveAttribute("aria-busy", "true");
      expect(
        screen.getByTestId("mcp-app-reload-indicator"),
      ).toBeInTheDocument();

      // Resolve the delayed resources/read fetch
      await act(async () => {
        resolveReloadFetch?.(
          makeResourceResponse("<html><body><div>v2</div></body></html>"),
        );
      });

      await vi.waitFor(() => {
        expect(
          bridgeInstances[1].sendSandboxResourceReady,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            html: "<html><body><div>v2</div></body></html>",
          }),
        );
      });

      // Progress indicator stays visible until the incoming guest signals ready
      expect(reloadButton).toHaveAttribute("aria-busy", "true");
      expect(
        screen.getByTestId("mcp-app-reload-indicator"),
      ).toBeInTheDocument();

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: reloadedIframe.contentWindow,
            origin: SANDBOX_ORIGIN,
            data: { type: "mcp-apps:guest-ready" },
          }),
        );
      });

      expect(reloadButton).not.toHaveAttribute("aria-busy");
      expect(reloadButton).not.toHaveAttribute("data-state");
      expect(
        screen.queryByTestId("mcp-app-reload-indicator"),
      ).not.toBeInTheDocument();
      expect(reloadedIframe.style.opacity).toBe("");
      expect(firstIframe.isConnected).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("exposes the Reload app button on the inline surface and shows progress until guest-ready", async () => {
    const user = userEvent.setup();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    installBridgeCollector(bridgeInstances);

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="inline"
          preloadedResource={{ html: "<html><body>Inline App</body></html>" }}
        />,
      );
    });

    const firstIframe = document.querySelector("iframe");
    if (!firstIframe) throw new Error("initial inline iframe did not mount");
    await notifySandboxProxyReady(firstIframe);

    const reloadButton = screen.getByRole("button", { name: /reload app/i });
    expect(reloadButton).toBeInTheDocument();

    await act(async () => {
      await user.click(reloadButton);
    });

    expect(reloadButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("mcp-app-reload-indicator")).toBeInTheDocument();

    const reloadedIframe = document.querySelectorAll("iframe")[0];
    await notifySandboxProxyReady(reloadedIframe);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: reloadedIframe.contentWindow,
          origin: SANDBOX_ORIGIN,
          data: { type: "mcp-apps:guest-ready" },
        }),
      );
    });

    expect(reloadButton).not.toHaveAttribute("aria-busy");
    expect(
      screen.queryByTestId("mcp-app-reload-indicator"),
    ).not.toBeInTheDocument();
  });

  it("buffers intermediate height reductions on the hidden incoming iframe during inline reload and applies the final settled height on mcp-apps:guest-ready", async () => {
    const user = userEvent.setup();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock internals
    const bridgeInstances: any[] = [];
    installBridgeCollector(bridgeInstances);

    await act(async () => {
      render(
        <McpAppSection
          {...defaultProps}
          surface="inline"
          preloadedResource={{ html: "<html><body>Inline App</body></html>" }}
        />,
      );
    });

    const firstIframe = document.querySelector("iframe");
    if (!firstIframe) throw new Error("initial inline iframe did not mount");
    await notifySandboxProxyReady(firstIframe);

    // Initial guest reports 238px height
    await act(async () => {
      bridgeInstances[0].onsizechange?.({ width: 640, height: 238 });
    });
    expect(firstIframe.style.height).toBe("238px");

    const reloadButton = screen.getByRole("button", { name: /reload app/i });
    await act(async () => {
      await user.click(reloadButton);
    });

    const iframes = Array.from(document.querySelectorAll("iframe"));
    expect(iframes).toHaveLength(2);
    const reloadedIframe = iframes[0];
    expect(reloadedIframe.style.opacity).toBe("0");
    expect(reloadedIframe.style.height).toBe("238px");
    expect(firstIframe.style.height).toBe("238px");

    await notifySandboxProxyReady(reloadedIframe);

    // Incoming guest reports an intermediate unhydrated height (120px) before guest-ready:
    // neither the visible outgoing iframe nor the hidden incoming iframe may shrink to 120px.
    await act(async () => {
      bridgeInstances[1].onsizechange?.({ width: 640, height: 120 });
    });
    expect(firstIframe.style.height).toBe("238px");
    expect(reloadedIframe.style.height).toBe("238px");

    // When mcp-apps:guest-ready arrives with the hydrated height (238px), the incoming
    // iframe reveals cleanly at 238px with zero intermediate collapse.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: reloadedIframe.contentWindow,
          origin: SANDBOX_ORIGIN,
          data: { type: "mcp-apps:guest-ready", height: 238 },
        }),
      );
    });

    expect(reloadedIframe.style.opacity).toBe("");
    expect(reloadedIframe.style.height).toBe("238px");
    expect(firstIframe.isConnected).toBe(false);
  });

  it("completes two-frame guest readiness with a restored control and nonzero measured height without canceling animation frames", async () => {
    const proxyHtml = readFileSync(
      join(__dirname, "../../../../backend/src/static/mcp-sandbox-proxy.html"),
      "utf-8",
    );
    const bootstrapStart = proxyHtml.indexOf(
      "function guestStateBootstrap(restored)",
    );
    const bootstrapEnd = proxyHtml.indexOf(
      "function buildStatePreservationScript(restoredState)",
    );
    const bootstrapFnSource = `(${proxyHtml.slice(bootstrapStart, bootstrapEnd).trim()})`;

    const guestReadyMessages: { height?: number }[] = [];
    const onParentMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; height?: number } | null;
      if (data?.type === "mcp-apps:guest-ready") {
        guestReadyMessages.push({ height: data.height });
      }
    };
    window.addEventListener("message", onParentMessage);

    const hostFrame = document.createElement("iframe");
    document.body.appendChild(hostFrame);
    const guestWin = hostFrame.contentWindow as Window & typeof globalThis;
    const guestDoc = hostFrame.contentDocument as Document;

    let rafCounter = 0;
    let rafRequestCount = 0;
    let rafCancelCount = 0;
    const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
    guestWin.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = ++rafCounter;
      rafRequestCount++;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        cb(performance.now());
      }, 17);
      rafTimers.set(id, timer);
      return id;
    }) as typeof guestWin.requestAnimationFrame;
    guestWin.cancelAnimationFrame = ((id: number) => {
      const timer = rafTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        rafTimers.delete(id);
        rafCancelCount++;
      }
    }) as typeof guestWin.cancelAnimationFrame;

    try {
      guestDoc.body.innerHTML = `<input id="search-input" type="text" value="" />`;
      guestDoc.documentElement.getBoundingClientRect = () =>
        ({ height: 238 }) as DOMRect;

      const restoreState = {
        contentHeight: 238,
        controls: {
          "#search-input": {
            kind: "form",
            selector: "#search-input",
            tag: "input",
            type: "text",
            value: "blue",
          },
        },
      };

      vm.runInNewContext(
        `(${bootstrapFnSource})(${JSON.stringify(restoreState)})`,
        {
          window: guestWin,
          document: guestDoc,
          Element: guestWin.Element,
          MutationObserver: guestWin.MutationObserver,
          Event: guestWin.Event,
          setTimeout: guestWin.setTimeout.bind(guestWin),
          clearTimeout: guestWin.clearTimeout.bind(guestWin),
          queueMicrotask: guestWin.queueMicrotask.bind(guestWin),
          Object,
          Array,
          String,
          Number,
          JSON,
          CSS: guestWin.CSS,
        },
      );

      await new Promise((r) => setTimeout(r, 120));

      const searchInput = guestDoc.getElementById(
        "search-input",
      ) as HTMLInputElement;
      expect(searchInput.value).toBe("blue");
      expect(guestReadyMessages).toEqual([{ height: 238 }]);
      expect(rafRequestCount).toBe(2);
      expect(rafCancelCount).toBe(0);
    } finally {
      for (const timer of rafTimers.values()) {
        clearTimeout(timer);
      }
      window.removeEventListener("message", onParentMessage);
      hostFrame.remove();
    }
  });
});
