import type {
  McpUiDisplayMode,
  McpUiResourceCsp,
  McpUiResourcePermissions,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  buildFullToolName,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  parseFullToolName,
} from "@shared";
import { useTheme } from "next-themes";
import type React from "react";
import { Component, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getMcpSandboxBaseUrl } from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils";

/** MCP CallToolResult — defined inline to avoid direct @modelcontextprotocol/sdk dependency. */
type McpCallToolResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Shape of MCP tool output stored by the backend in the AI SDK's tool result.
 * Contains a text string for model context plus rich metadata for UI rendering.
 *
 * Matches the return type of `executeMcpTool` in chat-mcp-client.ts.
 */
export type McpToolOutput = {
  /** Text representation for the model and text-only hosts */
  content: string;
  /** Additional metadata (timestamps, version info, etc.) not intended for model context */
  _meta?: Record<string, unknown>;
  /** Structured data optimized for UI rendering (not added to model context) */
  structuredContent?: Record<string, unknown>;
  /** Original MCP content blocks from the tool response */
  rawContent?: McpCallToolResult["content"];
};

const AVAILABLE_DISPLAY_MODES: McpUiDisplayMode[] = ["inline", "fullscreen"];

/** Reads a CSS custom property value from :root */
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * Collects all @font-face rules from the document's stylesheets and resolves
 * relative URLs to absolute so cross-origin sandbox iframes can load them.
 * Cached by stylesheet count to avoid repeated iteration.
 */
let _cachedFontFaces = "";
let _cachedSheetCount = -1;

function collectFontFacesCss(): string {
  if (document.styleSheets.length === _cachedSheetCount) {
    return _cachedFontFaces;
  }
  const rules: string[] = [];
  const origin = window.location.origin;
  try {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSFontFaceRule) {
            // Make relative src paths absolute for cross-origin iframe access
            const cssText = rule.cssText.replace(
              /url\((['"]?)(\/[^)'"]+)\1\)/g,
              (_match, _quote, path) => `url("${origin}${path}")`,
            );
            rules.push(cssText);
          }
        }
      } catch {
        // Cross-origin stylesheets are not accessible — skip
      }
    }
  } catch {
    // Ignore
  }
  _cachedSheetCount = document.styleSheets.length;
  _cachedFontFaces = rules.join("\n");
  return _cachedFontFaces;
}

/**
 * Maps Archestra's shadcn/tweakcn CSS variables to the MCP UI standardised
 * style variable keys so Views can theme themselves to match the host.
 * Cached by document.documentElement.className to avoid redundant reads.
 */
let _cachedStyles: McpUiStyles | null = null;
let _cachedClassName = "";

function buildMcpUiStyleVariables(): McpUiStyles {
  const currentClassName = document.documentElement.className;
  if (_cachedStyles && currentClassName === _cachedClassName) {
    return _cachedStyles;
  }
  const bg = getCssVar("--background");
  const fg = getCssVar("--foreground");
  const card = getCssVar("--card");
  const muted = getCssVar("--muted");
  const mutedFg = getCssVar("--muted-foreground");
  const border = getCssVar("--border");
  const ring = getCssVar("--ring");
  const destructive = getCssVar("--destructive");
  const primary = getCssVar("--primary");
  const primaryFg = getCssVar("--primary-foreground");
  const radius = getCssVar("--radius");
  const fontSans = getCssVar("--font-sans");
  const fontMono = getCssVar("--font-mono");
  const shadowSm = getCssVar("--shadow-sm");
  const shadowMd = getCssVar("--shadow-md");
  const shadowLg = getCssVar("--shadow-lg");

  const result: McpUiStyles = {
    // Backgrounds
    // primary  = page/app bg; secondary = elevated card/panel; tertiary = subtle muted surface
    "--color-background-primary": card,
    "--color-background-secondary": bg,
    "--color-background-tertiary": bg,
    "--color-background-inverse": primary,
    "--color-background-ghost": "transparent",
    "--color-background-info": undefined,
    "--color-background-danger": destructive,
    "--color-background-success": undefined,
    "--color-background-warning": undefined,
    "--color-background-disabled": border,
    // Text
    "--color-text-primary": fg,
    "--color-text-secondary": mutedFg,
    "--color-text-tertiary": fg,
    "--color-text-inverse": primaryFg,
    "--color-text-ghost": bg,
    "--color-text-info": primary,
    "--color-text-danger": destructive,
    "--color-text-success": undefined,
    "--color-text-warning": undefined,
    "--color-text-disabled": mutedFg,
    // Borders
    "--color-border-primary": border,
    "--color-border-secondary": border,
    "--color-border-tertiary": undefined,
    "--color-border-inverse": undefined,
    "--color-border-ghost": "transparent",
    "--color-border-info": undefined,
    "--color-border-danger": destructive,
    "--color-border-success": undefined,
    "--color-border-warning": undefined,
    "--color-border-disabled": muted,
    // Rings
    "--color-ring-primary": ring,
    "--color-ring-secondary": ring,
    "--color-ring-inverse": primaryFg,
    "--color-ring-info": ring,
    "--color-ring-danger": destructive,
    "--color-ring-success": undefined,
    "--color-ring-warning": undefined,
    // Typography — family
    "--font-sans": fontSans,
    "--font-mono": fontMono,
    // Typography — weight
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
    // Typography — text size
    "--font-text-xs-size": "0.75rem",
    "--font-text-sm-size": "0.875rem",
    "--font-text-md-size": "1rem",
    "--font-text-lg-size": "1.125rem",
    // Typography — heading size
    "--font-heading-xs-size": "1.25rem",
    "--font-heading-sm-size": "1.5rem",
    "--font-heading-md-size": "1.875rem",
    "--font-heading-lg-size": "2.25rem",
    "--font-heading-xl-size": "3rem",
    "--font-heading-2xl-size": "3.75rem",
    "--font-heading-3xl-size": "4.5rem",
    // Typography — text line height
    "--font-text-xs-line-height": "1rem",
    "--font-text-sm-line-height": "1.25rem",
    "--font-text-md-line-height": "1.5rem",
    "--font-text-lg-line-height": "1.75rem",
    // Typography — heading line height
    "--font-heading-xs-line-height": "1.75rem",
    "--font-heading-sm-line-height": "2rem",
    "--font-heading-md-line-height": "2.25rem",
    "--font-heading-lg-line-height": "2.5rem",
    "--font-heading-xl-line-height": "1",
    "--font-heading-2xl-line-height": "1",
    "--font-heading-3xl-line-height": "1",
    // Border radius
    "--border-radius-xs": "2px",
    "--border-radius-sm": `calc(${radius} - 4px)`,
    "--border-radius-md": `calc(${radius} - 2px)`,
    "--border-radius-lg": radius,
    "--border-radius-xl": `calc(${radius} + 4px)`,
    "--border-radius-full": "9999px",
    // Border width
    "--border-width-regular": "1px",
    // Shadows
    "--shadow-hairline": `0 0 0 1px ${border}`,
    "--shadow-sm": shadowSm,
    "--shadow-md": shadowMd,
    "--shadow-lg": shadowLg,
  };
  _cachedClassName = currentClassName;
  _cachedStyles = result;
  return result;
}

/** Catches render errors from MCP App iframes so a crashing app doesn't take down the chat. */
class McpAppErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          MCP App crashed: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Metadata extracted from a UI resource's _meta.ui (or meta for Python SDK quirk). */
interface AppResourceMeta {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

/**
 * Self-contained MCP App section for use inside a Tool collapsible.
 * Owns display-mode / size state and the rawToolResult derivation so the
 * parent only needs to forward the raw output from the tool part.
 */
export function McpAppSection({
  uiResourceUri,
  agentId,
  toolName,
  toolInput,
  rawOutput,
  preloadedResource,
  onSendMessage,
}: {
  uiResourceUri: string;
  agentId: string;
  /** Full prefixed tool name (e.g. "system__get-system-stats") — used to derive the server prefix for oncalltool */
  toolName: string;
  toolInput?: Record<string, unknown>;
  rawOutput: McpToolOutput | undefined;
  /** HTML pre-fetched by the backend and delivered via SSE — skips the in-browser HTTP fetch */
  preloadedResource?: AppResourceMeta;
  /** Called when the MCP App sends a ui/message request to inject a user message into the conversation */
  onSendMessage?: (text: string) => void;
}) {
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  // Reconstruct McpCallToolResult for AppFrame
  const toolResult = useMemo((): McpCallToolResult | undefined => {
    if (!rawOutput) return undefined;
    return {
      content: rawOutput.rawContent ?? [
        { type: "text" as const, text: rawOutput.content },
      ],
      structuredContent: rawOutput.structuredContent,
      _meta: rawOutput._meta,
      isError: false,
    };
  }, [rawOutput]);

  return (
    <McpAppErrorBoundary>
      <McpAppContainer
        displayMode={displayMode}
        onClose={() => setDisplayMode("inline")}
        size={size}
      >
        <McpAppView
          toolResourceUri={uiResourceUri}
          agentId={agentId}
          serverPrefix={parseFullToolName(toolName).serverName ?? toolName}
          displayMode={displayMode}
          onDisplayModeChange={setDisplayMode}
          onSizeChange={setSize}
          toolInput={toolInput}
          toolResult={toolResult}
          preloadedResource={preloadedResource}
          onSendMessage={onSendMessage}
        />
      </McpAppContainer>
    </McpAppErrorBoundary>
  );
}

/**
 * Container that handles display mode switching (inline ↔ fullscreen).
 *
 * Uses a single stable React tree for both modes so that children (iframe)
 * are never unmounted/remounted when toggling — only CSS classes change.
 *
 * In fullscreen, uses `position: fixed` sized to the Conversation scroll area
 * (found via `role="log"`) so the chat input remains visible below.
 */
function McpAppContainer({
  displayMode,
  onClose,
  children,
  size,
}: {
  displayMode: McpUiDisplayMode;
  onClose: () => void;
  children: React.ReactNode;
  size: { width: number; height: number } | null;
}) {
  const isFullscreen = displayMode === "fullscreen";
  const containerRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen, onClose]);

  // Cover the entire viewport in fullscreen mode
  useEffect(() => {
    if (!isFullscreen) {
      setBounds(null);
      return;
    }
    setBounds({
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const update = () => {
      setBounds({
        top: 0,
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [isFullscreen]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "will-change-auto origin-center transition-all duration-400 ease-[cubic-bezier(0.23,1,0.32,1)]",
        isFullscreen ? "fixed z-[100] bg-background flex flex-col" : "",
        isFullscreen && !bounds
          ? "opacity-0 scale-95 pointer-events-none"
          : "opacity-100 scale-100",
      )}
      style={
        isFullscreen && bounds
          ? {
              top: bounds.top,
              left: bounds.left,
              width: bounds.width,
              height: bounds.height,
            }
          : undefined
      }
    >
      {/* Close bar — animates in smoothly instead of snapping */}
      <div
        className={cn(
          "flex items-center justify-end border-b transition-all duration-300 overflow-hidden",
          isFullscreen
            ? "h-12 p-2 opacity-100"
            : "h-0 p-0 opacity-0 border-transparent",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Exit fullscreen"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </Button>
      </div>

      <div
        style={{
          maxHeight: isFullscreen
            ? `${bounds?.height || 1000}px`
            : `${Math.min(size?.height || 150, 500)}px`,
        }}
        className={cn(
          "transition-[max-height] duration-400 ease-[cubic-bezier(0.23,1,0.32,1)]",
          isFullscreen
            ? "flex-1 overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!min-h-0 [&_iframe]:!max-h-none [&_div]:!h-full"
            : "max-w-[80%] shadow-xs border border-border/50 rounded-lg [&_iframe]:!w-full overflow-y-hidden [&_div]:!max-h-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}

const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const SANDBOX_READY_TIMEOUT = 10_000;

/**
 * Creates a sandboxed iframe pointing to the sandbox proxy HTML and connects
 * an AppBridge to it.
 *
 * Replaces @mcp-ui/client's AppFrame which hardcodes allow-same-origin on the
 * iframe — incompatible with single-port deployments where the sandbox must
 * have an opaque origin to prevent access to the host's cookies/storage.
 */
function SandboxIframe({
  html,
  sandboxUrl,
  csp,
  permissions,
  appBridge,
  toolInput,
  toolResult,
  onError,
  onSizeChanged,
  useDedicatedOrigin,
}: {
  html: string;
  sandboxUrl: URL;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  appBridge: AppBridge;
  toolInput?: Record<string, unknown>;
  toolResult?: McpCallToolResult;
  onError?: (error: Error) => void;
  onSizeChanged?: (size: { width?: number; height?: number }) => void;
  /** When true, sandbox iframe uses allow-same-origin (dedicated subdomain provides isolation). */
  useDedicatedOrigin?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const onSizeChangedRef = useRef(onSizeChanged);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onSizeChangedRef.current = onSizeChanged;
    onErrorRef.current = onError;
  });

  // Create iframe, wait for proxy-ready, connect bridge
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    const iframe = document.createElement("iframe");
    iframe.style.width = "100%";
    iframe.style.height = "600px";
    iframe.style.border = "none";
    iframe.style.backgroundColor = "transparent";
    // With dedicated subdomain: allow-same-origin is safe (different origin from backend).
    // Without: no allow-same-origin → opaque origin for security isolation.
    iframe.setAttribute(
      "sandbox",
      useDedicatedOrigin
        ? "allow-scripts allow-same-origin allow-forms allow-popups"
        : "allow-scripts allow-forms allow-popups",
    );
    iframe.src = sandboxUrl.href;
    iframeRef.current = iframe;

    // Wait for sandbox-proxy-ready message from the iframe
    const timeout = setTimeout(() => {
      if (!cancelled) {
        const err = new Error("Timed out waiting for sandbox proxy iframe");
        setError(err);
        onErrorRef.current?.(err);
      }
    }, SANDBOX_READY_TIMEOUT);

    const onMessage = (event: MessageEvent) => {
      if (
        event.source === iframe.contentWindow &&
        event.data?.method === SANDBOX_PROXY_READY
      ) {
        if (cancelled) return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);

        // Connect AppBridge via PostMessageTransport
        // contentWindow is guaranteed non-null here (checked in event.source === iframe.contentWindow above)
        const cw = iframe.contentWindow as Window;
        const transport = new PostMessageTransport(cw, cw);
        appBridge
          .connect(transport)
          .then(() => {
            if (!cancelled) setReady(true);
          })
          .catch((err) => {
            if (!cancelled) {
              const error = err instanceof Error ? err : new Error(String(err));
              setError(error);
              onErrorRef.current?.(error);
            }
          });
      }
    };

    window.addEventListener("message", onMessage);
    container.appendChild(iframe);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      iframe.remove();
      iframeRef.current = null;
    };
  }, [sandboxUrl.href, appBridge, useDedicatedOrigin]);

  // Set up size change and initialized handlers
  useEffect(() => {
    if (!ready) return;

    appBridge.onsizechange = (params) => {
      onSizeChangedRef.current?.(params);
      const iframe = iframeRef.current;
      if (iframe) {
        if (params.width !== undefined)
          iframe.style.width = `${params.width}px`;
        if (params.height !== undefined)
          iframe.style.height = `${params.height}px`;
      }
    };

    appBridge.oninitialized = () => {
      setInitialized(true);
    };
  }, [ready, appBridge]);

  // Send HTML to sandbox once connected
  useEffect(() => {
    if (!ready || !html) return;
    appBridge
      .sendSandboxResourceReady({ html, csp, permissions })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        onErrorRef.current?.(error);
      });
  }, [ready, html, appBridge, csp, permissions]);

  // Send tool input when available
  useEffect(() => {
    if (!ready || !initialized || !toolInput) return;
    appBridge.sendToolInput({ arguments: toolInput });
  }, [ready, initialized, toolInput, appBridge]);

  // Send tool result when available
  useEffect(() => {
    if (!ready || !initialized || !toolResult) return;
    // Cast needed: our McpCallToolResult is looser than the SDK's strict union type
    // biome-ignore lint/suspicious/noExplicitAny: McpCallToolResult is structurally compatible but TypeScript can't prove it
    appBridge.sendToolResult(toolResult as any);
  }, [ready, initialized, toolResult, appBridge]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {error && (
        <div style={{ color: "red", padding: "1rem" }}>
          Error: {error.message}
        </div>
      )}
    </div>
  );
}

/**
 * Renders an MCP App using AppBridge + SandboxIframe directly
 * so we can handle ui/request-display-mode requests with the proper protocol response.
 */

const McpAppView = function McpAppView({
  toolResourceUri,
  agentId,
  serverPrefix,
  toolInput,
  toolResult,
  displayMode,
  onDisplayModeChange,
  onSizeChange,
  onError,
  onSendMessage,
  preloadedResource,
}: {
  toolResourceUri: string;
  agentId: string;
  /** Server name prefix from the DB tool name (e.g. "system" from "system__get-system-stats") */
  serverPrefix: string;
  toolInput?: Record<string, unknown>;
  toolResult?: McpCallToolResult;
  displayMode: McpUiDisplayMode;
  onDisplayModeChange: (mode: McpUiDisplayMode) => void;
  onSizeChange: (size: { width: number; height: number }) => void;
  onError?: (error: Error) => void;
  /** Called when the MCP App sends a ui/message request to inject a user message into the conversation */
  onSendMessage?: (text: string) => void;
  /** HTML pre-fetched by the backend — skips the in-browser HTTP fetch to avoid SSE deadlock */
  preloadedResource?: AppResourceMeta;
}) {
  const { resolvedTheme } = useTheme();
  const [bridge, setBridge] = useState<AppBridge | null>(null);
  const [appResource, setAppResource] = useState<AppResourceMeta | null>(
    preloadedResource ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Use refs for all callbacks to avoid recreating bridge when props change
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
  const onDisplayModeChangeRef = useRef(onDisplayModeChange);
  onDisplayModeChangeRef.current = onDisplayModeChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSizeChangeRef = useRef(onSizeChange);
  onSizeChangeRef.current = onSizeChange;
  const onSendMessageRef = useRef(onSendMessage);
  onSendMessageRef.current = onSendMessage;
  // Ref to the latest bridge for teardown — avoids capturing a stale closure
  const latestBridgeRef = useRef<AppBridge | null>(null);
  // Monotonic counter for JSON-RPC IDs to avoid collisions from Date.now() in rapid calls.
  const rpcIdRef = useRef(0);
  // Shared cancel ref so the prop-update useEffect can cancel an in-flight fallback fetch.
  const fetchCancelledRef = useRef(false);

  // Create bridge + fetch HTML (once per agentId/resourceUri — callbacks via refs)
  // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks accessed via stable refs
  useEffect(() => {
    let cancelled = false;
    fetchCancelledRef.current = false;

    const appBridge = new AppBridge(
      null,
      {
        name: "Archestra",
        version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
      },
      { openLinks: {}, logging: {}, serverResources: {}, serverTools: {} },
      {
        hostContext: {
          displayMode: displayModeRef.current,
          theme: (resolvedThemeRef.current ?? "light") as "light" | "dark",
          platform: "web",
          availableDisplayModes: AVAILABLE_DISPLAY_MODES,
          containerDimensions: { maxHeight: 500 },
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          userAgent: `Archestra/${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}`,
          styles: {
            variables: buildMcpUiStyleVariables(),
            css: { fonts: collectFontFacesCss() },
          },
        },
      },
    );

    appBridge.onrequestdisplaymode = async ({ mode }) => {
      if ((AVAILABLE_DISPLAY_MODES as string[]).includes(mode)) {
        onDisplayModeChangeRef.current(mode as McpUiDisplayMode);
        return { mode };
      }
      return { mode: displayModeRef.current };
    };

    appBridge.onopenlink = async ({ url }) => {
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return {};
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        // malformed URL — ignore
      }
      return {};
    };

    // Proxy a JSON-RPC method to the backend MCP gateway.
    const mcpProxy = async (method: string, params: unknown) => {
      const response = await fetch(`/api/mcp/${agentId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcIdRef.current,
          method,
          params,
        }),
      });
      if (!response.ok)
        throw new Error(`Failed to fetch ${method}: ${response.statusText}`);
      const json = await response.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    };

    appBridge.oncalltool = async (params) => {
      // Always enforce the server prefix — strip any existing prefix to prevent
      // a compromised MCP App from calling tools on a different server.
      const rawName = parseFullToolName(params.name).toolName;
      const toolName = buildFullToolName(serverPrefix, rawName);

      return mcpProxy("tools/call", {
        name: toolName,
        arguments: params.arguments,
      });
    };

    // Scope resource/prompt handlers to the owning server to prevent a compromised
    // MCP App from accessing resources on other servers attached to the same agent.
    // Match the server prefix as a complete segment to prevent a substring
    // bypass (e.g. "evil-stats" matching "stats").
    const prefixPattern = `${serverPrefix}://`;
    const prefixSeparator = `${serverPrefix}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;

    appBridge.onreadresource = async (params) => {
      const uri = (params as { uri?: string }).uri;
      if (
        typeof uri === "string" &&
        !uri.startsWith(prefixPattern) &&
        !uri.includes(`/${serverPrefix}/`)
      ) {
        throw new Error("Resource not accessible from this MCP App");
      }
      return mcpProxy("resources/read", params);
    };
    appBridge.onlistresources = async () => {
      const result = await mcpProxy("resources/list", {});
      if (result?.resources) {
        result.resources = (result.resources as { uri?: string }[]).filter(
          (r) =>
            typeof r.uri === "string" &&
            (r.uri.startsWith(prefixPattern) ||
              r.uri.includes(`/${serverPrefix}/`)),
        );
      }
      return result;
    };
    appBridge.onlistresourcetemplates = async () => {
      const result = await mcpProxy("resources/templates/list", {});
      if (result?.resourceTemplates) {
        result.resourceTemplates = (
          result.resourceTemplates as { uriTemplate?: string }[]
        ).filter(
          (r) =>
            typeof r.uriTemplate === "string" &&
            (r.uriTemplate.startsWith(prefixPattern) ||
              r.uriTemplate.includes(`/${serverPrefix}/`)),
        );
      }
      return result;
    };
    appBridge.onlistprompts = async () => {
      const result = await mcpProxy("prompts/list", {});
      if (result?.prompts) {
        result.prompts = (result.prompts as { name?: string }[]).filter(
          (p) =>
            typeof p.name === "string" &&
            (p.name === serverPrefix || p.name.startsWith(prefixSeparator)),
        );
      }
      return result;
    };

    appBridge.onloggingmessage = (params) => {
      // biome-ignore lint/suspicious/noConsole: intentional — surfaces MCP App logs from sandboxed iframe
      console.debug("[MCP App]", params.level, params.data);
    };

    // ui/message — View injects a user message into the conversation.
    // Text blocks are concatenated; non-text blocks are ignored.
    // Cap length to prevent a compromised MCP App from injecting arbitrarily long text.
    const MAX_MESSAGE_LENGTH = 10_000;
    appBridge.onmessage = async (params) => {
      const text = (params.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string)
        .join("\n")
        .slice(0, MAX_MESSAGE_LENGTH);
      if (text) onSendMessageRef.current?.(text);
      return {};
    };

    // TODO: implement ui/update-model-context
    // AppBridge re-exported from @mcp-ui/client does not expose the `onupdatemodelcontext`
    // setter in its TypeScript declarations even though the underlying
    // @modelcontextprotocol/ext-apps@1.0.1 app-bridge.d.ts defines it.
    // Casting through `any` at runtime silences the compiler but the setter has no
    // effect because @mcp-ui/client ships its own bundled copy of AppBridge that may
    // not include the handler wiring. Revisit once @mcp-ui/client exposes the type.

    if (!cancelled) {
      setBridge(appBridge);
    }

    // Skip HTTP fetch when the backend already sent the HTML via SSE.
    if (preloadedResource) {
      if (!cancelled) setAppResource(preloadedResource);
      return () => {
        cancelled = true;
        appBridge.teardownResource({}).catch(() => {});
      };
    }

    // Fallback: fetch UI resource HTML + metadata (CSP, permissions) directly.
    // Only reached when the backend prefetch was skipped (e.g. tool called from
    // a context where SSE is no longer open).
    (async () => {
      try {
        const result = await mcpProxy("resources/read", {
          uri: toolResourceUri,
        });
        const content = result?.contents?.[0];
        if (!content) throw new Error("Empty resource contents");

        let html: string | undefined;
        try {
          html =
            "blob" in content && content.blob
              ? atob(content.blob)
              : content.text;
        } catch (err) {
          console.error("Failed to decode resource content:", err);
          html = content.text;
        }

        if (!html) throw new Error("Resource has no text or blob content");

        const csp = content._meta?.ui?.csp;
        const permissions = content._meta?.ui?.permissions;

        if (!cancelled && !fetchCancelledRef.current) {
          setAppResource({ html, csp, permissions });
        }
      } catch (err) {
        if (!cancelled && !fetchCancelledRef.current) {
          const error = err instanceof Error ? err : new Error(String(err));
          setLoadError(error.message);
          onErrorRef.current?.(error);
        }
      }
    })();

    return () => {
      cancelled = true;
      fetchCancelledRef.current = true;
      appBridge.teardownResource({}).catch(() => {});
    };
  }, [agentId, toolResourceUri]);

  // If preloadedResource arrives as a prop update after initial mount (race
  // condition: tool part rendered before the SSE event was processed), apply it.
  // Only set if no resource is loaded yet to avoid overwriting a fetch result.
  // Cancel any in-flight fallback fetch to prevent a double-render.
  useEffect(() => {
    if (preloadedResource && !appResource && !loadError) {
      fetchCancelledRef.current = true;
      setAppResource(preloadedResource);
    }
  }, [preloadedResource, appResource, loadError]);

  // Send partial inputs during streaming. The Vercel AI SDK populates part.input
  // progressively during input-streaming state, so toolInput changes on each delta.
  // Once toolResult arrives the tool call is complete — no more partials needed.
  useEffect(() => {
    if (!bridge || !toolInput || toolResult) return;
    if (Object.keys(toolInput).length === 0) return;
    bridge.sendToolInputPartial({ arguments: toolInput })?.catch(() => {});
  }, [bridge, toolInput, toolResult]);

  // Sync display mode changes → bridge
  useEffect(() => {
    if (bridge) {
      bridge.setHostContext({
        displayMode,
        availableDisplayModes: AVAILABLE_DISPLAY_MODES,
        containerDimensions:
          displayMode === "fullscreen" ? {} : { maxHeight: 500 },
      });
    }
  }, [bridge, displayMode]);

  // Sync theme/style changes → bridge via MutationObserver on html[class].
  // Covers both light/dark toggling (adds/removes "dark" class) and color-theme
  // changes (swaps "theme-xxx" class), both of which alter CSS custom properties.
  useEffect(() => {
    if (!bridge) return;
    const observer = new MutationObserver(() => {
      bridge.setHostContext({
        theme: document.documentElement.classList.contains("dark")
          ? "dark"
          : "light",
        styles: { variables: buildMcpUiStyleVariables() },
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, [bridge]);

  // Keep latestBridgeRef in sync so the teardown cleanup has the current bridge.
  useEffect(() => {
    latestBridgeRef.current = bridge;
  }, [bridge]);

  // Signal the View to clean up before the iframe is destroyed (ui/resource-teardown).
  // The bridge MUST be told to teardown before the component unmounts so the View can
  // save state, cancel pending operations, etc. Empty deps = cleanup runs only on unmount.
  useEffect(() => {
    return () => {
      latestBridgeRef.current?.teardownResource({}).catch(() => {});
    };
  }, []);

  // Build sandbox URL with CSP query param for HTTP header-based CSP enforcement.
  // Three modes: domain subdomain, localhost swap (Inspector pattern), or opaque origin fallback.
  const mcpSandboxDomain = useFeature("mcpSandboxDomain");
  const sandboxResult = useMemo(
    () => getMcpSandboxBaseUrl(mcpSandboxDomain, serverPrefix),
    [mcpSandboxDomain, serverPrefix],
  );
  const sandboxUrl = useMemo(() => {
    if (!appResource) return null;
    // CSP is passed via sendSandboxResourceReady message, not URL query params.
    // The proxy HTML builds and injects CSP as a meta tag into the guest HTML.
    return new URL(
      `${sandboxResult.baseUrl}/_sandbox/mcp-sandbox-proxy.html`,
      window.location.origin,
    );
  }, [appResource, sandboxResult.baseUrl]);

  return (
    <div>
      {loadError && (
        <div className="flex items-center justify-center rounded-lg bg-destructive/10 border border-destructive/20 min-h-[100px] p-4">
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="text-sm font-medium text-destructive">
              Failed to load app
            </span>
            <span className="text-xs text-muted-foreground">{loadError}</span>
          </div>
        </div>
      )}
      {!loadError && (!bridge || !appResource) && (
        <div className="flex items-center justify-center rounded-lg bg-muted/50 min-h-[100px]">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span className="text-sm">Loading...</span>
          </div>
        </div>
      )}
      {!loadError && appResource && bridge && sandboxUrl && (
        <SandboxIframe
          html={appResource.html}
          sandboxUrl={sandboxUrl}
          csp={appResource.csp}
          permissions={appResource.permissions}
          appBridge={bridge}
          toolInput={toolInput}
          toolResult={toolResult}
          onError={onError}
          onSizeChanged={(size) => {
            onSizeChangeRef.current({
              width: size.width ?? 0,
              height: size.height ?? 0,
            });
          }}
          useDedicatedOrigin={sandboxResult.hasCrossOrigin}
        />
      )}
    </div>
  );
};
