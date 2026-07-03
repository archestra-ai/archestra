"use client";

import {
  archestraApiSdk,
  buildFullToolName,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  parseFullToolName,
} from "@archestra/shared";
import type {
  McpUiDisplayMode,
  McpUiResourceCsp,
  McpUiResourcePermissions,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps";
import {
  AppBridge,
  buildAllowAttribute,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INITIAL_INLINE_HEIGHT } from "@/components/mcp-app/app-height";
import { McpAppAuthBanner } from "@/components/mcp-app/mcp-app-auth-banner";
import {
  getAppDiagnostics,
  parseForwardedDiagnostic,
  reportAppDiagnostic,
} from "@/lib/chat/app-diagnostics-store";
import {
  type ConnectableAuthState,
  resolveMcpAppToolCallAuthState,
} from "@/lib/chat/mcp-error-ui";
import { getMcpSandboxBaseUrl } from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";

/**
 * The MCP gateway an app runtime talks to. An `agent` endpoint carries an
 * agent's whole tool surface (many upstream servers) and rewrites/scopes calls
 * to a single server prefix; an `app` endpoint is route-bound to one app whose
 * own server enforces the allowlist + visibility, so calls pass through as-is.
 */
type McpAppEndpoint =
  | { kind: "agent"; agentId: string; serverPrefix: string }
  | { kind: "app"; appId: string }
  | { kind: "server"; mcpServerId: string };

/** MCP CallToolResult — defined inline to avoid direct @modelcontextprotocol/sdk dependency. */
export type McpCallToolResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

/** Metadata extracted from a UI resource's _meta.ui (or meta for Python SDK quirk). */
export interface AppResourceMeta {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

const AVAILABLE_DISPLAY_MODES: McpUiDisplayMode[] = ["inline", "fullscreen"];

// Screenshot payloads arrive over an untrusted postMessage lane and a forged
// one can bypass the SDK's self-cap, so the host re-checks size and MIME before
// posting — matching the backend cap (routes/app.ts) so an oversized/invalid
// payload never traverses the wire.
const MAX_SCREENSHOT_DATA_URL_LENGTH = 2_000_000;
const SCREENSHOT_DATA_URL_PREFIX = /^data:image\/(png|jpeg|webp);base64,/;

/** Default pre-report iframe height on surfaces that supply no inline ceiling
 * (standalone run page, app preview) — those fill their own layout instead. */
const UNCAPPED_INITIAL_HEIGHT = 600;

/** The `containerDimensions` hint sent to the guest: an honest inline ceiling,
 * or `{}` when uncapped (fullscreen, or a surface that supplies no ceiling). */
function containerDimensionsHint(
  displayMode: McpUiDisplayMode,
  maxHeight: number | null | undefined,
): { maxHeight?: number } {
  return displayMode === "fullscreen" || maxHeight == null ? {} : { maxHeight };
}

/**
 * Renders an MCP App using AppBridge + SandboxIframe directly so we can handle
 * ui/request-display-mode requests with the proper protocol response. Decoupled
 * from chat: drive it with an {@link McpAppEndpoint} (agent or app), supply a
 * resource URI, and own the display-mode/size state in the caller.
 */
export const McpAppRuntime = function McpAppRuntime({
  toolResourceUri,
  endpoint,
  toolInput,
  toolResult,
  displayMode,
  onDisplayModeChange,
  onSizeChange,
  onError,
  onSendMessage,
  preloadedResource,
  onResourceStateChange,
  appVersion,
  containerDimensions,
  reloadNonce,
  inlineInitialHeight,
}: {
  toolResourceUri: string;
  endpoint: McpAppEndpoint;
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
  onResourceStateChange: (state: "renderable" | "empty") => void;
  /** Owned-app version this render shows — keys the render-loop diagnostics. */
  appVersion?: number | null;
  /** Container size hint forwarded to the guest (SEP-1865 `containerDimensions`).
   * `maxHeight` is the inline visual ceiling from the host card; absent on
   * full-bleed surfaces (run page, preview). Drives the guest size hint and the
   * pre-report height. */
  containerDimensions?: { maxHeight?: number };
  /** Bump to remount (reload) the sandboxed iframe — re-runs its creation effect. */
  reloadNonce?: number;
  /** Last measured inline height; seeds the iframe + loading box so a fresh
   * mount (e.g. returning from the panel) doesn't collapse before the app loads. */
  inlineInitialHeight?: number;
}) {
  const { resolvedTheme } = useTheme();
  // The host only ever caps height (width is unbounded); unpack the SEP-shaped
  // hint into the single value the size logic below threads through.
  const containerMaxHeight = containerDimensions?.maxHeight;
  const [bridge, setBridge] = useState<AppBridge | null>(null);
  const [appResource, setAppResource] = useState<AppResourceMeta | null>(
    preloadedResource ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  // Auth error from the app's most recent proxied tools/call — drives a
  // host-side connect banner above the iframe (see McpAppAuthBanner).
  const [toolCallAuthError, setToolCallAuthError] =
    useState<McpAppToolCallAuthError | null>(null);

  // Stable identity for the bridge-creation effect — re-run when the endpoint or
  // resource changes, never on unrelated re-renders. The effect derives its
  // gateway URL from the endpoint it closed over, so it always matches the
  // bridge it built (no cross-endpoint routing during a transition).
  const endpointKey =
    endpoint.kind === "agent"
      ? `agent:${endpoint.agentId}:${endpoint.serverPrefix}`
      : endpoint.kind === "server"
        ? `server:${endpoint.mcpServerId}`
        : `app:${endpoint.appId}`;
  // Sandbox-subdomain hash seed. Apps get a per-app bucket matching the backend
  // MCP server name; isolation does not depend on this being collision-free.
  const sandboxPrefix =
    endpoint.kind === "agent"
      ? endpoint.serverPrefix
      : endpoint.kind === "server"
        ? `archestra-mcp-server-${endpoint.mcpServerId}`
        : `archestra-app-${endpoint.appId}`;

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
  const onResourceStateChangeRef = useRef(onResourceStateChange);
  onResourceStateChangeRef.current = onResourceStateChange;
  // Ref to the latest bridge for teardown — avoids capturing a stale closure
  const latestBridgeRef = useRef<AppBridge | null>(null);
  // Monotonic counter for JSON-RPC IDs to avoid collisions from Date.now() in rapid calls.
  const rpcIdRef = useRef(0);
  // Shared cancel ref so the prop-update useEffect can cancel an in-flight fallback fetch.
  const fetchCancelledRef = useRef(false);
  // Last height the guest reported. A reload recreates the iframe; starting it at
  // this height (instead of the default) avoids a collapse-then-grow jump while
  // the reloaded app re-reports its size.
  const lastReportedHeightRef = useRef<number | null>(null);

  // Render-loop diagnostics (owned apps only): runtime errors / CSP violations
  // forwarded by the sandbox proxy are validated and collected per
  // (appId, version) so the chat can hand them back to the authoring model.
  const ownedAppId = endpoint.kind === "app" ? endpoint.appId : null;
  const appVersionRef = useRef(appVersion);
  appVersionRef.current = appVersion;
  const containerMaxHeightRef = useRef(containerMaxHeight);
  containerMaxHeightRef.current = containerMaxHeight;

  // Persist a snapshot of this render server-side so get_app_diagnostics can
  // read it within the authoring turn (the next-user-message attachment path is
  // untouched). Best-effort, fire-and-forget; the backend orders by version and
  // merges same-version posts, so concurrent mounts are safe.
  const postDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The version whose first diagnostics were already posted early, so a noisy
  // app can't drive an unbounded stream of network writes (the settle timer
  // still posts the final state).
  const earlyPostedVersionRef = useRef<number | null>(null);
  const postRenderSnapshot = useCallback(() => {
    if (!ownedAppId) return;
    const version = appVersionRef.current;
    if (version == null) return; // the server keys snapshots by a concrete version
    const current = getAppDiagnostics(ownedAppId);
    const entries =
      current && current.version === version ? current.entries : [];
    void archestraApiSdk
      .postAppRenderDiagnostics({
        path: { appId: ownedAppId },
        body: { version, entries },
      })
      .catch(() => {});
  }, [ownedAppId]);

  const handleDiagnostic = useCallback(
    (data: unknown) => {
      if (!ownedAppId) return;
      const entry = parseForwardedDiagnostic(data);
      if (!entry) return;
      const version = appVersionRef.current ?? null;
      const changed = reportAppDiagnostic(ownedAppId, version, entry);
      // One early post per version (debounced to coalesce a burst), so the
      // model sees failures without waiting for the settle timer below.
      if (
        changed &&
        version != null &&
        earlyPostedVersionRef.current !== version &&
        !postDebounceRef.current
      ) {
        earlyPostedVersionRef.current = version;
        postDebounceRef.current = setTimeout(() => {
          postDebounceRef.current = null;
          postRenderSnapshot();
        }, RENDER_DIAGNOSTIC_POST_DEBOUNCE_MS);
      }
    },
    [ownedAppId, postRenderSnapshot],
  );

  // Screenshot capture: the SDK lane posts a JPEG data URL tagged with the app
  // version it captured. Fire-and-forget POST it for the current head version,
  // ignoring stale captures from an older mount (mirrors diagnostics ordering).
  const handleScreenshot = useCallback(
    (data: unknown) => {
      if (!ownedAppId) return;
      const record = data as { version?: unknown; dataUrl?: unknown } | null;
      const version = record?.version;
      const dataUrl = record?.dataUrl;
      if (typeof version !== "number" || typeof dataUrl !== "string") return;
      if (version !== appVersionRef.current) return;
      if (
        dataUrl.length > MAX_SCREENSHOT_DATA_URL_LENGTH ||
        !SCREENSHOT_DATA_URL_PREFIX.test(dataUrl)
      ) {
        return;
      }
      void archestraApiSdk
        .postAppRenderScreenshot({
          path: { appId: ownedAppId },
          body: { version, dataUrl },
        })
        .catch(() => {});
    },
    [ownedAppId],
  );

  // Once the resource is renderable, post one snapshot after a short settle
  // window — including the empty (rendered-clean) case — keyed on the version so
  // each new render reports.
  useEffect(() => {
    if (!ownedAppId || !appResource || appVersion == null) return;
    const timer = setTimeout(postRenderSnapshot, RENDER_SETTLE_POST_MS);
    return () => clearTimeout(timer);
  }, [ownedAppId, appResource, appVersion, postRenderSnapshot]);

  useEffect(
    () => () => {
      if (postDebounceRef.current) clearTimeout(postDebounceRef.current);
    },
    [],
  );
  // No unmount clear: several mounts of one app coexist (inline card + sidebar
  // portal), so one unmount must not wipe another's entries. Lifecycle is
  // handled by drain-at-send, newer-version reset, and conversation switch.

  // Create bridge + fetch HTML (once per endpoint/resourceUri — callbacks via refs)
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
          // Fall back to the <html> class when the theme hook hasn't hydrated
          // yet (hard load): next-themes stamps the class pre-React, so a
          // dark-mode page never announces itself as light.
          theme: (resolvedThemeRef.current ?? readDocumentTheme()) as
            | "light"
            | "dark",
          platform: "web",
          availableDisplayModes: AVAILABLE_DISPLAY_MODES,
          containerDimensions: containerDimensionsHint(
            displayModeRef.current,
            containerMaxHeightRef.current,
          ),
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

    // Gateway URL derived from the endpoint this effect closed over — always
    // matches the bridge built below.
    const mcpUrl =
      endpoint.kind === "agent"
        ? `/api/mcp/${endpoint.agentId}`
        : endpoint.kind === "server"
          ? `/api/mcp/server/${endpoint.mcpServerId}`
          : `/api/mcp/app/${endpoint.appId}`;

    // Proxy a JSON-RPC method to the backend MCP gateway (agent or app endpoint).
    const mcpProxy = async (method: string, params: unknown) => {
      const response = await fetch(mcpUrl, {
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

    // Proxy a tools/call and sniff the result for the gateway's auth-required /
    // auth-expired refusal (structured `archestraError`, prose fallback). The
    // result still flows to the app unchanged; the host additionally raises a
    // connect banner OUTSIDE the iframe — the app may only print the error
    // text, and the sandbox blocks popups so an in-app link couldn't open.
    // A fresh render (endpoint/resource/reload change) starts with no banner.
    setToolCallAuthError(null);
    const proxyToolCall = async (params: {
      name: string;
      arguments?: unknown;
    }) => {
      const result = await mcpProxy("tools/call", params);
      const authState = resolveMcpAppToolCallAuthState(result);
      if (authState) {
        const next = { toolName: params.name, authState };
        // Keep the previous object when the same refusal repeats (an app retry
        // loop) so the banner doesn't re-render on every failed call.
        setToolCallAuthError((prev) =>
          prev && isSameToolCallAuthError(prev, next) ? prev : next,
        );
      }
      return result;
    };

    if (endpoint.kind === "agent") {
      const serverPrefix = endpoint.serverPrefix;

      appBridge.oncalltool = async (params) => {
        // Always enforce the server prefix — strip any existing prefix to prevent
        // a compromised MCP App from calling tools on a different server.
        const rawName = parseFullToolName(params.name).toolName;
        const toolName = buildFullToolName(serverPrefix, rawName);

        return proxyToolCall({
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
    } else {
      // App endpoint: the route-bound app server is the authority (per-app
      // allowlist + visibility), so tool names pass through unrewritten — the
      // app's upstream tools keep their own server prefix and app_data tools are
      // archestra-branded. The app server serves only its own single UI resource
      // (and ignores the requested URI), and implements ONLY resources/read — so
      // list/template/prompt handlers return empty rather than hitting an
      // unimplemented method.
      appBridge.oncalltool = async (params) =>
        proxyToolCall({
          name: params.name,
          arguments: params.arguments,
        });
      appBridge.onreadresource = async (params) =>
        mcpProxy("resources/read", params);
      appBridge.onlistresources = async () => ({ resources: [] });
      appBridge.onlistresourcetemplates = async () => ({
        resourceTemplates: [],
      });
      appBridge.onlistprompts = async () => ({ prompts: [] });
    }

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
      if (!cancelled) {
        setAppResource(preloadedResource);
        onResourceStateChangeRef.current(
          isRenderableMcpAppHtml(preloadedResource.html)
            ? "renderable"
            : "empty",
        );
      }
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
          onResourceStateChangeRef.current(
            isRenderableMcpAppHtml(html) ? "renderable" : "empty",
          );
        }
      } catch (err) {
        if (!cancelled && !fetchCancelledRef.current) {
          const error = err instanceof Error ? err : new Error(String(err));
          setLoadError(error.message);
          onResourceStateChangeRef.current("renderable");
          onErrorRef.current?.(error);
        }
      }
    })();

    return () => {
      cancelled = true;
      fetchCancelledRef.current = true;
      appBridge.teardownResource({}).catch(() => {});
    };
    // reloadNonce: bumping it rebuilds the bridge from scratch (a clean reload).
    // The iframe reconnects automatically since SandboxIframe's connect effect
    // keys on the bridge identity — remounting only the iframe would instead
    // reconnect the already-connected bridge and throw.
  }, [endpointKey, toolResourceUri, reloadNonce]);

  // If preloadedResource arrives as a prop update after initial mount (race
  // condition: tool part rendered before the SSE event was processed), apply it.
  // Only set if no resource is loaded yet to avoid overwriting a fetch result.
  // Cancel any in-flight fallback fetch to prevent a double-render.
  useEffect(() => {
    if (preloadedResource && !appResource && !loadError) {
      fetchCancelledRef.current = true;
      setAppResource(preloadedResource);
      onResourceStateChangeRef.current(
        isRenderableMcpAppHtml(preloadedResource.html) ? "renderable" : "empty",
      );
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
        containerDimensions: containerDimensionsHint(
          displayMode,
          containerMaxHeight,
        ),
      });
    }
  }, [bridge, displayMode, containerMaxHeight]);

  // Sync theme/style changes → bridge via MutationObserver on html[class].
  // Covers both light/dark toggling (adds/removes "dark" class) and color-theme
  // changes (swaps "theme-xxx" class), both of which alter CSS custom properties.
  useEffect(() => {
    if (!bridge) return;
    const observer = new MutationObserver(() => {
      bridge.setHostContext({
        theme: readDocumentTheme(),
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
    () => getMcpSandboxBaseUrl(mcpSandboxDomain, sandboxPrefix),
    [mcpSandboxDomain, sandboxPrefix],
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
      {toolCallAuthError && (
        <McpAppAuthBanner
          toolName={toolCallAuthError.toolName}
          authState={toolCallAuthError.authState}
          onDismiss={() => setToolCallAuthError(null)}
        />
      )}
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
        <div
          className="flex items-center justify-center rounded-lg bg-muted/50 min-h-[100px]"
          style={
            inlineInitialHeight != null
              ? { minHeight: `${inlineInitialHeight}px` }
              : undefined
          }
        >
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
            if (typeof size.height === "number" && size.height > 0) {
              lastReportedHeightRef.current = size.height;
            }
            onSizeChangeRef.current({
              width: size.width ?? 0,
              height: size.height ?? 0,
            });
          }}
          useDedicatedOrigin={sandboxResult.hasCrossOrigin}
          initialHeight={
            lastReportedHeightRef.current ??
            inlineInitialHeight ??
            (containerMaxHeight != null
              ? INITIAL_INLINE_HEIGHT
              : UNCAPPED_INITIAL_HEIGHT)
          }
          maxHeight={containerMaxHeight}
          onDiagnostic={ownedAppId ? handleDiagnostic : undefined}
          onScreenshot={ownedAppId ? handleScreenshot : undefined}
          ownedApp={ownedAppId != null}
        />
      )}
    </div>
  );
};

/** An auth refusal from a proxied tools/call, plus the tool that hit it. */
type McpAppToolCallAuthError = {
  toolName: string;
  authState: ConnectableAuthState;
};

/** Same auth refusal (tool + kind + action URL): the banner needn't update. */
function isSameToolCallAuthError(
  a: McpAppToolCallAuthError,
  b: McpAppToolCallAuthError,
): boolean {
  const urlOf = (state: ConnectableAuthState) =>
    state.kind === "auth-expired" ? state.reauthUrl : state.actionUrl;
  return (
    a.toolName === b.toolName &&
    a.authState.kind === b.authState.kind &&
    urlOf(a.authState) === urlOf(b.authState)
  );
}

const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const SANDBOX_READY_TIMEOUT = 10_000;

// Coalesce a burst of render errors into one early server post.
const RENDER_DIAGNOSTIC_POST_DEBOUNCE_MS = 400;
// Settle window after a resource becomes renderable before posting the snapshot
// (incl. the rendered-clean empty case).
const RENDER_SETTLE_POST_MS = 1_500;

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
  initialHeight = UNCAPPED_INITIAL_HEIGHT,
  maxHeight,
  onDiagnostic,
  onScreenshot,
  ownedApp,
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
  /** Iframe height before the first app size report. */
  initialHeight?: number;
  /**
   * Visual ceiling for the iframe height. When set, reported heights are clamped
   * to it so a viewport-relative app (e.g. one sized to `100vh`) can't drive the
   * auto-resize SDK into an ever-growing feedback loop; content past the cap
   * scrolls within the iframe. Absent on uncapped surfaces (panel fill,
   * fullscreen, apps page).
   */
  maxHeight?: number;
  /** Raw runtime-error / csp-violation payloads forwarded by the sandbox proxy. */
  onDiagnostic?: (data: unknown) => void;
  /** Raw screenshot payload forwarded by the sandbox proxy. */
  onScreenshot?: (data: unknown) => void;
  /** Archestra-owned app: its envelope carries the platform CSP, so the proxy
   * must not inject a second one. A trusted host signal, not derived from HTML. */
  ownedApp?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Track WHICH bridge is connected, not just a boolean: a reload swaps in a new
  // bridge instance, and `ready` must read false the instant the identity changes
  // — otherwise the send effects below fire against the not-yet-connected bridge
  // and throw "Not connected".
  const [connectedBridge, setConnectedBridge] = useState<AppBridge | null>(
    null,
  );
  const ready = connectedBridge === appBridge;
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const onSizeChangedRef = useRef(onSizeChanged);
  const onErrorRef = useRef(onError);
  const onDiagnosticRef = useRef(onDiagnostic);
  const onScreenshotRef = useRef(onScreenshot);
  // Read at iframe-creation time only; a ref keeps it out of the effect deps so
  // the iframe never remounts when the height changes.
  const initialHeightRef = useRef(initialHeight);
  // Read inside the (effect-bound) size handler; a ref keeps the latest cap
  // without re-binding onsizechange on every cap change.
  const maxHeightRef = useRef(maxHeight);
  // Permissions-Policy delegation for the outer proxy iframe. The inner app
  // frame is delegated the same way inside the sandbox proxy; both reuse the
  // library's mapping so a feature must be granted on EVERY frame in the chain.
  // Derived to a stable primitive so it can gate the iframe-creation effect
  // without the raw `permissions` object (new reference each render) forcing
  // needless remounts.
  const allowAttribute = useMemo(
    () => buildAllowAttribute(permissions),
    [permissions],
  );

  useEffect(() => {
    onSizeChangedRef.current = onSizeChanged;
    onErrorRef.current = onError;
    onDiagnosticRef.current = onDiagnostic;
    onScreenshotRef.current = onScreenshot;
    initialHeightRef.current = initialHeight;
    maxHeightRef.current = maxHeight;
  });

  // Create iframe, wait for proxy-ready, connect bridge
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    const iframe = document.createElement("iframe");
    iframe.style.width = "100%";
    iframe.style.height = `${initialHeightRef.current}px`;
    iframe.style.border = "none";
    iframe.style.backgroundColor = "transparent";
    // Propagate the host theme into the sandbox chain: per CSS Color
    // Adjustment, the frame element's used color-scheme sets the embedded
    // document's *preferred* color scheme, and the proxy hands it on to the
    // app frame (`color-scheme: inherit` + its `light dark` meta). Apps that
    // theme via `@media (prefers-color-scheme)` / `light-dark()` instead of
    // the bridge's hostContext.theme then follow the app theme rather than
    // the OS — matching how desktop MCP hosts render them.
    iframe.style.colorScheme = readDocumentTheme();
    const themeObserver = new MutationObserver(() => {
      iframe.style.colorScheme = readDocumentTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    // With dedicated subdomain: allow-same-origin is safe (different origin from backend).
    // Without: no allow-same-origin → opaque origin for security isolation.
    iframe.setAttribute(
      "sandbox",
      useDedicatedOrigin
        ? "allow-scripts allow-same-origin allow-forms allow-popups"
        : "allow-scripts allow-forms allow-popups",
    );

    // Delegate declared Permissions-Policy features (camera/mic/geo/clipboard)
    // to the proxy frame so it can pass them on to the inner app frame — without
    // this the inner frame's `allow` is inert. Powerful features cannot be
    // delegated to an opaque origin, so they only take effect on a dedicated
    // sandbox origin; warn rather than fail silently otherwise.
    if (allowAttribute) {
      iframe.setAttribute("allow", allowAttribute);
      if (!useDedicatedOrigin) {
        console.warn(
          `MCP App requested permissions (${allowAttribute}) but the sandbox runs on an opaque origin; ` +
            "browser Permissions-Policy cannot grant them. Configure a dedicated sandbox origin (mcpSandboxDomain).",
        );
      }
    }

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

    // Without allow-same-origin the sandboxed proxy iframe runs on an opaque
    // origin, which postMessage reports as the literal string "null".
    const expectedOrigin = useDedicatedOrigin ? sandboxUrl.origin : "null";

    const onMessage = (event: MessageEvent) => {
      if (
        event.source === iframe.contentWindow &&
        event.origin === expectedOrigin &&
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
            if (!cancelled) setConnectedBridge(appBridge);
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

    // Persistent diagnostics listener: the proxy forwards runtime errors,
    // CSP violations, and screenshots from the inner app frame; payloads are
    // untrusted and are validated by the consumers.
    const onDiagnosticMessage = (event: MessageEvent) => {
      if (
        event.source !== iframe.contentWindow ||
        event.origin !== expectedOrigin
      ) {
        return;
      }
      const type = (event.data as { type?: unknown } | null)?.type;
      if (
        type === "mcp-apps:runtime-error" ||
        type === "mcp-apps:csp-violation"
      ) {
        onDiagnosticRef.current?.(event.data);
      } else if (type === "mcp-apps:screenshot") {
        onScreenshotRef.current?.(event.data);
      }
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("message", onDiagnosticMessage);
    container.appendChild(iframe);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      themeObserver.disconnect();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("message", onDiagnosticMessage);
      iframe.remove();
      iframeRef.current = null;
      // Reset connection state so the send effects below don't fire against a
      // bridge whose iframe we just removed. Without this, ready/initialized
      // stay stale-true after a re-render that re-runs this effect (e.g.
      // editing a message re-renders the message list), and sendToolInput
      // throws "Not connected".
      setConnectedBridge((current) => (current === appBridge ? null : current));
      setInitialized(false);
    };
  }, [
    sandboxUrl.href,
    sandboxUrl.origin,
    appBridge,
    useDedicatedOrigin,
    allowAttribute,
  ]);

  // Set up size change and initialized handlers
  useEffect(() => {
    if (!ready) return;

    appBridge.onsizechange = (params) => {
      // Clamp to the surface ceiling before applying or reporting: an app sized
      // to the iframe viewport (e.g. 100vh) otherwise makes each measurement
      // taller than the last, inflating the iframe without bound. Reporting the
      // clamped height also keeps the frozen panel placeholder honest.
      const max = maxHeightRef.current;
      const height =
        params.height !== undefined && max != null
          ? Math.min(params.height, max)
          : params.height;
      onSizeChangedRef.current?.({ width: params.width, height });
      const iframe = iframeRef.current;
      if (iframe) {
        if (params.width !== undefined)
          iframe.style.width = `${params.width}px`;
        if (height !== undefined) iframe.style.height = `${height}px`;
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
      // `ownedApp` is a trusted host signal: Archestra-owned apps carry the
      // platform CSP in their backend envelope, so the proxy must not add a
      // second one. It is NOT in the ext-apps notification type, but the
      // notification forwards params verbatim and the proxy reads it raw.
      .sendSandboxResourceReady({
        html,
        csp,
        permissions,
        ...(ownedApp ? { ownedApp: true } : {}),
      } as Parameters<typeof appBridge.sendSandboxResourceReady>[0])
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        onErrorRef.current?.(error);
      });
  }, [ready, html, appBridge, csp, permissions, ownedApp]);

  // Send tool input when available
  useEffect(() => {
    if (!ready || !initialized || !toolInput) return;
    // Guard the synchronous send: the bridge can drop between render and effect
    // (iframe closed by a re-render). A dropped bridge is transient — the effect
    // re-fires once it reconnects — so swallow rather than crash the page.
    try {
      appBridge.sendToolInput({ arguments: toolInput });
    } catch (err) {
      console.warn(
        "[mcp-app] sendToolInput skipped (bridge not connected)",
        err,
      );
    }
  }, [ready, initialized, toolInput, appBridge]);

  // Send tool result when available
  useEffect(() => {
    if (!ready || !initialized || !toolResult) return;
    try {
      // Cast needed: our McpCallToolResult is looser than the SDK's strict union type
      // biome-ignore lint/suspicious/noExplicitAny: McpCallToolResult is structurally compatible but TypeScript can't prove it
      appBridge.sendToolResult(toolResult as any);
    } catch (err) {
      console.warn(
        "[mcp-app] sendToolResult skipped (bridge not connected)",
        err,
      );
    }
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
 * Detects MCP App resources that would create an empty iframe/canvas panel.
 * Tool results can mark a UI resource even when that resource has no visible
 * body content; rendering it reserves a blank chat panel before the next
 * message or sensitive-context divider. Keep resources that can still render
 * later through scripts or visual/interactive elements.
 */
export function isRenderableMcpAppHtml(html: string): boolean {
  const trimmedHtml = html.trim();
  if (!trimmedHtml) {
    return false;
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(trimmedHtml, "text/html");

  // A script anywhere in the document (commonly a <head> module script that
  // mounts the app into an otherwise-empty <body>, e.g. Excalidraw) can build
  // the UI at runtime, so the resource is renderable even with an empty body.
  if (document.querySelector("script")) {
    return true;
  }

  const body = document.body;

  if (body.textContent?.trim()) {
    return true;
  }

  return Boolean(
    body.querySelector(
      [
        "canvas",
        "svg",
        "img",
        "picture",
        "video",
        "audio",
        "iframe",
        "object",
        "embed",
        "table",
        "form",
        "input",
        "textarea",
        "select",
        "button",
        "[role]",
        "[aria-label]",
      ].join(","),
    ),
  );
}

// ── Host-theme bridging helpers ──────────────────────────────────────────────

/**
 * The host's light/dark theme, read from the class next-themes stamps on
 * `<html>` (set synchronously by its inline script, so it's correct even
 * before the `useTheme()` hook has hydrated).
 */
function readDocumentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

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
