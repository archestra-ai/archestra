import {
  CLAUDE_CODE_PROXY_ENV_KEYS,
  CLAUDE_DESKTOP_CLIENT_ID,
  type ClientMark,
  EXTERNAL_AGENT_ID_HEADER,
  OPENCODE_FAMILY,
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  type OpenCodeFamilyDescriptor,
  openCodePassthroughBaseUrl,
  PI_MARK,
  type SupportedProvider,
} from "@archestra/shared";
import {
  INSTALLER_CLIENT_KEY_PROVIDERS,
  NATIVE_SESSION_CLIENT_LABELS,
} from "@archestra/shared/connection-setup";
import {
  CLAUDE_MARK,
  GROK_MARK,
  HERMES_AGENT_MARK,
  KIMI_MARK,
  OPENAI_MARK,
  OPENCLAW_MARK,
} from "@/components/client-marks";

const [ANTHROPIC_BASE_URL_KEY] = CLAUDE_CODE_PROXY_ENV_KEYS.anthropic;
const [CLAUDE_USE_BEDROCK_KEY, AWS_REGION_KEY, BEDROCK_BASE_URL_KEY] =
  CLAUDE_CODE_PROXY_ENV_KEYS.bedrock;

/**
 * Title of the final wizard step for OAuth-gated clients. Registering the
 * gateway only tells the client where it lives — the gateway authorizes each
 * user individually, so a one-time browser sign-in is still needed before its
 * tools work.
 */
export const FINISH_OAUTH_FLOW_TITLE = "Finish the OAuth flow";

export interface ClientStep {
  title: string;
  body?: string;
  /** Optional per-step command, rendered in an inline terminal beneath the step. */
  buildCommand?: (params: McpBuildParams) => string;
  /** Language for this step's terminal. Falls back to the parent `language`. */
  language?: "json" | "toml" | "bash";
  /** Title for this step's terminal. Falls back to the parent `configFile`. */
  terminalTitle?: string;
  /**
   * When set, renders the inline auth-header picker (token selector +
   * copyable `Bearer …` value) beneath this step. Used by the token-auth
   * path so the value lives next to the step that consumes it.
   */
  showAuthHeader?: boolean;
  /**
   * When `showAuthHeader` is true and this is also true, render the raw
   * token without the `Bearer ` prefix. For clients whose credential UI
   * prepends the scheme automatically (e.g. n8n's Bearer Auth credential).
   */
  authHeaderBare?: boolean;
}

/** Parameters handed to the MCP config builder at render time. */
export interface McpBuildParams {
  /** The MCP gateway URL — e.g. http://localhost:9000/v1/mcp/<slug>. */
  url: string;
  /** Bearer token to embed. `null` when user chose OAuth. */
  token: string | null;
  /** Logical server name to register the gateway under in the client's config. */
  serverName: string;
}

/** Which authentication methods a client accepts for the MCP gateway. */
export type McpSupportedAuth = "oauth" | "token" | "both";

export type McpSupport =
  | { kind: "unsupported"; reason: string }
  | { kind: "generic"; supportedAuth: McpSupportedAuth }
  | {
      kind: "custom";
      supportedAuth: McpSupportedAuth;
      /**
       * Preferred auth tab — controls tab ordering and whether the OAuth tab
       * gets a "Recommended" chip. Defaults to "oauth".
       */
      preferredAuth?: "oauth" | "token";
      /**
       * When true, the client exposes a working deeplink — we show only the
       * one-click CTA and hide the manual steps + config block. Requires `cta`.
       */
      quick?: boolean;
      /** Shown in the "config file" label above the code block. */
      configFile: string;
      /** Language hint for syntax highlighting. */
      language: "json" | "toml" | "bash";
      steps: ClientStep[] | ((params: McpBuildParams) => ClientStep[]);
      /**
       * Returns the code snippet to display in the side-by-side layout. Omit
       * when steps carry their own per-step commands (vertical layout).
       */
      buildConfig?: (params: McpBuildParams) => string;
      /** Optional one-click install CTA (required when `quick` is true). */
      cta?: {
        label: string;
        buildHref: (params: McpBuildParams) => string;
      };
    };

/** Parameters handed to the proxy snippet builder. */
export interface ProxyBuildParams {
  provider: SupportedProvider;
  providerLabel: string;
  /** Proxy URL — e.g. http://localhost:9000/v1/<provider>/<profileId>. */
  url: string;
  /** Placeholder shown where the user should paste a real key. */
  tokenPlaceholder: string;
  /** Slug of the LLM proxy (profile) name — for use as a provider id in client configs. */
  proxyName: string;
  /**
   * The deployment's display name, for prose that refers to this platform.
   * Threaded in rather than hardcoded so a white-labeled deployment's connect
   * instructions read under its own brand.
   */
  appName: string;
}

/** A proxy step — either descriptive (title/body) or with a copyable code block beneath it. */
export interface ProxyStep {
  title: string;
  body?: string;
  /** Pre-rendered code for this step's terminal block. */
  code?: string;
  language?: "json" | "toml" | "bash";
  /** Inline labelled values rendered as individual rows. Non-copyable rows render as plain text (e.g. for placeholder values the user must replace). */
  fields?: { label: string; value: string; copyable?: boolean }[];
  /**
   * When true, render the inline passthrough-key reveal beneath this step: it
   * auto-provisions the user's personal passthrough virtual key and shows the
   * X-Archestra-Virtual-Key header name + copyable value. Gated on
   * llmVirtualKey:create. Used by the attribution step for manual clients.
   */
  showPassthroughKey?: boolean;
  /**
   * Reveal layout: "header" (default) shows separate name + value rows for a
   * custom-headers UI (Claude Desktop); "env" shows one copyable
   * ANTHROPIC_CUSTOM_HEADERS value for an env block (Claude Code).
   */
  passthroughKeyVariant?: "header" | "env";
  /**
   * When set, the passthrough-key reveal also surfaces an X-Archestra-Agent-Id
   * client-attribution header with this value (e.g. CLAUDE_DESKTOP_CLIENT_ID),
   * folded into the same ANTHROPIC_CUSTOM_HEADERS value (env) or as its own
   * header row (header).
   */
  passthroughKeyAgentId?: string;
}

export type ProxyInstruction =
  | {
      kind: "snippet";
      code: string;
      language: "json" | "bash" | "toml" | "typescript" | "python" | "yaml";
      note?: string;
    }
  | {
      kind: "steps";
      steps: ProxyStep[];
      note?: string;
    }
  | {
      kind: "sections";
      sections: { title: string; description?: string; steps: ProxyStep[] }[];
      note?: string;
    };

export type ProxySupport =
  | { kind: "unsupported"; reason: string }
  | { kind: "generic" }
  | {
      kind: "custom";
      /** Providers this client can speak to. Others render as "not compatible". */
      supportedProviders: SupportedProvider[];
      build: (params: ProxyBuildParams) => ProxyInstruction;
    };

export interface ConnectClient {
  id: string;
  label: string;
  sub: string;
  svg?: string;
  /**
   * Second-tone shape drawn beneath `svg`, for two-tone marks a single path
   * can't carry (e.g. OpenCode's lighter inner block).
   */
  svgAccent?: { path: string; color: string };
  /** viewBox for `svg` when it isn't drawn in the default 24×24 box. */
  svgViewBox?: string;
  svgFillRule?: "evenodd";
  iconColor?: string;
  tileBg?: string;
  iconOverride?: { bg: string; fg: string; glyph: string };
  mcp: McpSupport;
  proxy: ProxySupport;
}

const CURSOR_PATH =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";
const N8N_PATH =
  "M21.4737 5.6842c-1.1772 0-2.1663.8051-2.4468 1.8947h-2.8955c-1.235 0-2.289.893-2.492 2.111l-.1038.623a1.263 1.263 0 0 1-1.246 1.0555H11.289c-.2805-1.0896-1.2696-1.8947-2.4468-1.8947s-2.1663.8051-2.4467 1.8947H4.973c-.2805-1.0896-1.2696-1.8947-2.4468-1.8947C1.1311 9.4737 0 10.6047 0 12s1.131 2.5263 2.5263 2.5263c1.1772 0 2.1663-.8051 2.4468-1.8947h1.4223c.2804 1.0896 1.2696 1.8947 2.4467 1.8947 1.1772 0 2.1663-.8051 2.4468-1.8947h1.0008a1.263 1.263 0 0 1 1.2459 1.0555l.1038.623c.203 1.218 1.257 2.111 2.492 2.111h.3692c.2804 1.0895 1.2696 1.8947 2.4468 1.8947 1.3952 0 2.5263-1.131 2.5263-2.5263s-1.131-2.5263-2.5263-2.5263c-1.1772 0-2.1664.805-2.4468 1.8947h-.3692a1.263 1.263 0 0 1-1.246-1.0555l-.1037-.623A2.52 2.52 0 0 0 13.9607 12a2.52 2.52 0 0 0 .821-1.4794l.1038-.623a1.263 1.263 0 0 1 1.2459-1.0555h2.8955c.2805 1.0896 1.2696 1.8947 2.4468 1.8947 1.3952 0 2.5263-1.131 2.5263-2.5263s-1.131-2.5263-2.5263-2.5263m0 1.2632a1.263 1.263 0 0 1 1.2631 1.2631 1.263 1.263 0 0 1-1.2631 1.2632 1.263 1.263 0 0 1-1.2632-1.2632 1.263 1.263 0 0 1 1.2632-1.2631M2.5263 10.7368A1.263 1.263 0 0 1 3.7895 12a1.263 1.263 0 0 1-1.2632 1.2632A1.263 1.263 0 0 1 1.2632 12a1.263 1.263 0 0 1 1.2631-1.2632m6.3158 0A1.263 1.263 0 0 1 10.1053 12a1.263 1.263 0 0 1-1.2632 1.2632A1.263 1.263 0 0 1 7.579 12a1.263 1.263 0 0 1 1.2632-1.2632m10.1053 3.7895a1.263 1.263 0 0 1 1.2631 1.2632 1.263 1.263 0 0 1-1.2631 1.2631 1.263 1.263 0 0 1-1.2632-1.2631 1.263 1.263 0 0 1 1.2632-1.2632";
const COPILOT_PATH =
  "M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 0 0-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 0 0 .51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 0 1-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 0 1-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 0 1-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 0 0-.84-.044z";

/**
 * A tile's glyph fields for a shared client mark. Clients that are also in
 * the agent catalog take their mark from `@/components/client-marks`, so the
 * Connect page and the agent pages draw the same logo.
 */
function markFields(mark: ClientMark) {
  return {
    svg: mark.path,
    svgAccent: mark.accent,
    svgViewBox: mark.viewBox,
    svgFillRule: mark.fillRule,
    iconColor: mark.color,
    tileBg: mark.background,
  };
}

// Marks for the popular agents below, from LobeHub Icons (factory.ai's own
// favicon for Droid). All but Droid's use the 24×24 box with even-odd fills.
const AMP_PATH =
  "M15.087 23.18L12.03 24l-2.097-7.823-5.738 5.738-2.251-2.251 5.718-5.719-7.769-2.082.82-3.057 11.294 3.08 3.08 11.295zM19.505 18.762l-3.057.82-2.564-9.573-9.572-2.564.819-3.057 11.295 3.079 3.08 11.295zM23.893 14.374l-3.057.82-2.565-9.572L8.7 3.057 9.52 0l11.295 3.08 3.079 11.294z";
const ANTIGRAVITY_PATH =
  "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z";
const KIRO_PATH =
  "M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z";
const FACTORY_PATH =
  "M321.997 150.712C321.401 150.568 320.844 150.299 320.363 149.925C319.883 149.551 319.491 149.08 319.215 148.544C318.938 148.008 318.783 147.42 318.76 146.821C318.738 146.22 318.848 145.624 319.084 145.07C327.226 125.716 330.819 110.23 325.021 103.747C309.666 86.5471 248.085 120.749 228.451 132.333C227.925 132.642 227.337 132.837 226.728 132.903C226.118 132.969 225.501 132.906 224.918 132.719C224.336 132.531 223.801 132.223 223.351 131.815C222.902 131.407 222.548 130.909 222.313 130.356C214.06 111.043 205.384 97.6094 196.589 97.0268C173.279 95.4688 154.491 162.187 148.991 183.932C148.844 184.515 148.57 185.06 148.188 185.528C147.805 185.998 147.323 186.381 146.775 186.651C146.227 186.921 145.626 187.072 145.012 187.094C144.399 187.116 143.788 187.009 143.221 186.778C123.406 178.825 107.545 175.316 100.914 180.98C83.305 195.978 118.315 256.126 130.175 275.304C130.492 275.816 130.692 276.391 130.76 276.987C130.829 277.582 130.765 278.186 130.573 278.755C130.381 279.325 130.065 279.847 129.647 280.286C129.228 280.725 128.718 281.07 128.15 281.298C108.384 289.359 94.6306 297.834 94.0272 306.424C92.439 329.192 160.74 347.544 183.01 352.916C183.605 353.061 184.16 353.33 184.64 353.704C185.118 354.077 185.509 354.548 185.785 355.083C186.061 355.618 186.215 356.205 186.237 356.803C186.26 357.402 186.151 357.998 185.916 358.551C177.773 377.905 174.181 393.398 179.979 399.874C195.334 417.074 256.921 382.877 276.556 371.293C277.081 370.984 277.67 370.789 278.28 370.722C278.889 370.655 279.507 370.717 280.09 370.905C280.673 371.093 281.207 371.402 281.657 371.81C282.106 372.219 282.46 372.717 282.694 373.271C290.947 392.578 299.616 406.012 308.417 406.601C331.728 408.153 350.516 341.44 356.009 319.688C356.157 319.106 356.432 318.562 356.816 318.094C357.2 317.625 357.682 317.243 358.231 316.974C358.779 316.705 359.381 316.554 359.995 316.533C360.608 316.511 361.219 316.619 361.786 316.85C381.601 324.803 397.455 328.304 404.093 322.648C421.702 307.65 386.684 247.495 374.825 228.317C374.51 227.804 374.312 227.229 374.245 226.634C374.177 226.039 374.242 225.436 374.434 224.868C374.626 224.299 374.941 223.777 375.358 223.338C375.775 222.899 376.284 222.552 376.85 222.323C396.623 214.261 410.376 205.786 410.973 197.196C412.568 174.428 344.26 156.078 321.997 150.712ZM295.254 128.885C299.734 136.73 276.646 189 259.474 225.561C259.186 226.172 258.715 226.682 258.121 227.024C257.528 227.365 256.842 227.521 256.155 227.47C255.468 227.419 254.814 227.164 254.28 226.739C253.746 226.314 253.358 225.739 253.169 225.093C246.234 201.322 238.306 173.392 229.824 149.683C229.491 148.752 229.508 147.736 229.871 146.817C230.235 145.897 230.921 145.133 231.808 144.662C252.989 133.363 289.234 118.358 295.254 128.885ZM193.746 135.355C202.589 137.807 224.103 190.714 238.424 228.426C238.664 229.056 238.699 229.742 238.527 230.393C238.354 231.044 237.983 231.627 237.461 232.065C236.939 232.503 236.292 232.775 235.608 232.844C234.923 232.913 234.234 232.775 233.632 232.45C211.501 220.453 185.694 206.159 162.529 195.253C161.622 194.823 160.901 194.093 160.493 193.192C160.085 192.292 160.018 191.279 160.303 190.335C167.12 167.736 181.865 132.069 193.746 135.355ZM126.652 210.04C134.676 205.664 188.197 228.216 225.621 244.989C226.248 245.269 226.771 245.73 227.12 246.31C227.47 246.889 227.629 247.56 227.577 248.23C227.524 248.901 227.264 249.54 226.828 250.062C226.393 250.582 225.805 250.962 225.143 251.147C200.813 257.921 172.211 265.664 147.937 273.949C146.985 274.272 145.946 274.255 145.007 273.9C144.067 273.545 143.286 272.876 142.805 272.011C131.257 251.322 115.867 215.92 126.652 210.04ZM133.275 309.188C135.779 300.551 189.952 279.537 228.562 265.548C229.207 265.315 229.91 265.28 230.576 265.448C231.243 265.617 231.84 265.98 232.288 266.49C232.736 266.999 233.015 267.631 233.085 268.299C233.155 268.968 233.015 269.641 232.682 270.23C220.392 291.846 205.758 317.053 194.592 339.672C194.156 340.561 193.409 341.269 192.486 341.668C191.563 342.068 190.525 342.134 189.557 341.853C166.42 335.235 129.905 320.792 133.275 309.188ZM209.739 374.722C205.252 366.884 228.347 314.608 245.519 278.054C245.806 277.442 246.279 276.931 246.872 276.59C247.465 276.249 248.151 276.093 248.838 276.144C249.525 276.194 250.179 276.45 250.713 276.875C251.247 277.3 251.634 277.874 251.824 278.521C258.759 302.285 266.686 330.222 275.169 353.932C275.499 354.862 275.481 355.877 275.117 356.795C274.752 357.713 274.064 358.475 273.178 358.945C252.004 370.223 215.752 385.256 209.76 374.722H209.739ZM311.247 368.252C302.397 365.807 280.883 312.894 266.562 275.182C266.322 274.55 266.285 273.862 266.458 273.21C266.63 272.559 267.003 271.974 267.526 271.536C268.049 271.097 268.697 270.826 269.382 270.758C270.068 270.69 270.759 270.83 271.361 271.157C293.485 283.154 319.299 297.455 342.457 308.362C343.366 308.789 344.089 309.519 344.497 310.42C344.905 311.321 344.971 312.335 344.683 313.28C337.872 335.912 323.128 371.544 311.247 368.252ZM378.341 293.566C370.31 297.949 316.795 275.391 279.365 258.618C278.738 258.338 278.215 257.877 277.866 257.297C277.516 256.718 277.357 256.047 277.409 255.377C277.461 254.706 277.722 254.067 278.158 253.546C278.593 253.025 279.181 252.646 279.843 252.461C304.18 245.687 332.775 237.943 357.049 229.658C358.003 229.335 359.043 229.353 359.984 229.709C360.925 230.065 361.706 230.737 362.188 231.603C373.729 252.285 389.119 287.693 378.341 293.566ZM371.718 194.419C369.207 203.063 315.041 224.077 276.431 238.066C275.784 238.3 275.08 238.335 274.413 238.167C273.746 237.999 273.148 237.635 272.698 237.124C272.249 236.613 271.972 235.98 271.903 235.31C271.833 234.641 271.975 233.966 272.311 233.377C284.594 211.768 299.228 186.554 310.394 163.935C310.833 163.048 311.58 162.343 312.502 161.945C313.425 161.546 314.462 161.481 315.429 161.76C338.566 168.413 375.081 182.815 371.718 194.419Z";

/**
 * Popular agents without tailored steps. Listing them lets people find their
 * app by name; picking one shows the generic instructions under its label.
 */
const POPULAR_GENERIC_CLIENTS: (Pick<
  ConnectClient,
  | "id"
  | "label"
  | "sub"
  | "svg"
  | "svgViewBox"
  | "svgFillRule"
  | "svgAccent"
  | "iconColor"
  | "tileBg"
> & { proxy?: ProxySupport })[] = [
  {
    id: "amp",
    label: "Amp",
    sub: "Sourcegraph coding agent",
    svg: AMP_PATH,
    iconColor: "#f34e3f",
    tileBg: "#fff1ef",
    proxy: {
      kind: "unsupported",
      reason: "Amp sends its model requests to its own service.",
    },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    sub: "Google agentic IDE",
    svg: ANTIGRAVITY_PATH,
    iconColor: "#3186ff",
    tileBg: "#eef4ff",
    proxy: {
      kind: "unsupported",
      reason: "Antigravity sends its model requests to its own service.",
    },
  },
  {
    id: "droid",
    label: "Droid",
    sub: "Factory coding agent",
    svg: FACTORY_PATH,
    svgViewBox: "84 84 340 340",
    iconColor: "#020202",
    tileBg: "#f6f6f6",
  },
  {
    id: "grok-build",
    label: "Grok Build",
    sub: "xAI coding agent",
    ...markFields(GROK_MARK),
  },
  {
    id: "hermes-agent",
    label: "Hermes Agent",
    sub: "Nous Research agent",
    ...markFields(HERMES_AGENT_MARK),
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    sub: "Kimi coding agent",
    ...markFields(KIMI_MARK),
  },
  {
    id: "kiro",
    label: "Kiro",
    sub: "AWS agentic IDE",
    svg: KIRO_PATH,
    iconColor: "#9046ff",
    tileBg: "#f4eeff",
    proxy: {
      kind: "unsupported",
      reason: "Kiro sends its model requests to its own service.",
    },
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    sub: "Personal AI assistant",
    ...markFields(OPENCLAW_MARK),
  },
];

export const CONNECT_CLIENTS: ConnectClient[] = [
  {
    id: "claude-code",
    label: NATIVE_SESSION_CLIENT_LABELS["claude-code"],
    sub: "Anthropic CLI",
    ...markFields(CLAUDE_MARK),
    mcp: {
      kind: "custom",
      supportedAuth: "oauth",
      configFile: "terminal",
      language: "bash",
      steps: [
        {
          title: "Add the gateway",
          terminalTitle: "terminal",
          buildCommand: ({ url, serverName }) =>
            `claude mcp add --scope user --transport http ${shellArg(serverName)} ${shellArg(url)}`,
        },
        {
          title:
            "Open Claude and run /mcp. Select the gateway you just added and kick off the OAuth flow.",
          terminalTitle: "terminal",
          buildCommand: () => "claude /mcp",
        },
        {
          title: FINISH_OAUTH_FLOW_TITLE,
          body: "Claude Code opens your browser. Sign in and approve the gateway — it grants tool access per user, so its tools stay unavailable until you complete this one-time sign-in.",
        },
      ],
    },
    proxy: {
      kind: "custom",
      supportedProviders: ["anthropic", "bedrock"],
      build: ({ provider, url, tokenPlaceholder, appName }) => {
        if (provider === "bedrock") {
          return {
            kind: "steps",
            steps: [
              {
                title: "Open ~/.claude/settings.json",
                body: "Create the file if it doesn't exist.",
              },
              {
                title: "Add the Bedrock proxy settings to env",
                body: "Merge the snippet below into the file (keep your existing keys). Update AWS_REGION if you use a different one.",
                language: "json",
                code: JSON.stringify(
                  {
                    env: {
                      [CLAUDE_USE_BEDROCK_KEY]: "1",
                      [AWS_REGION_KEY]: "us-east-1",
                      [BEDROCK_BASE_URL_KEY]: url,
                    },
                  },
                  null,
                  2,
                ),
              },
              {
                title: "Export your Bedrock API key in the shell",
                body: "Keep the token out of files on disk.",
                language: "bash",
                code: `export AWS_BEARER_TOKEN_BEDROCK="${tokenPlaceholder}"
claude`,
              },
            ],
          };
        }
        return {
          kind: "steps",
          steps: [
            {
              title: "Open ~/.claude/settings.json",
              body: "Create the file if it doesn't exist.",
            },
            {
              title: `Add the ${appName} base URL to env`,
              body: "Merge the snippet below into the file (keep your existing keys). Your Claude subscription keeps working as-is.",
              language: "json",
              code: JSON.stringify(
                { env: { [ANTHROPIC_BASE_URL_KEY]: url } },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    sub: "Anthropic desktop app",
    ...markFields(CLAUDE_MARK),
    mcp: {
      kind: "custom",
      supportedAuth: "oauth",
      configFile: "Custom connector",
      language: "json",
      steps: [
        {
          title: "Enable developer mode",
          body: "From the Claude menu choose Help → Troubleshooting → Enable Developer Mode.",
        },
        {
          title: 'Open "Configure Third-Party Inference"',
          body: "From the Claude menu choose Developer → Configure Third-Party Inference….",
        },
        {
          title: "Add a Managed MCP server",
          body: 'Go to "Connectors & extensions". Click "Add server" and select "Blank".',
        },
        {
          title: "Paste the gateway URL",
          terminalTitle: "Remote MCP server URL",
          buildCommand: ({ url }) => url,
        },
        {
          title: FINISH_OAUTH_FLOW_TITLE,
          body: "Claude Desktop opens your browser. Sign in and approve the gateway — it grants tool access per user, so the connector's tools appear in chat only after this one-time sign-in.",
        },
      ],
    },
    proxy: {
      kind: "custom",
      supportedProviders: ["anthropic"],
      build: ({ url }) => ({
        kind: "steps",
        steps: [
          {
            title: "Enable developer mode",
            body: "From the Claude menu choose Help → Troubleshooting → Enable Developer Mode.",
          },
          {
            title: 'Open "Configure Third-Party Inference"',
            body: "From the Claude menu choose Developer → Configure Third-Party Inference….",
          },
          {
            title: "Fill in the credential",
            body: 'Paste the values below into the "API Key" and "Base URL" fields, then click "Save".',
            fields: [
              { label: "Gateway URL", value: url },
              {
                label: "API Key",
                value: "<your-anthropic-api-key-or-standard-virtual-key>",
                copyable: false,
              },
            ],
          },
          {
            title: "Add your personal auth key header",
            body: 'In the same form, expand "Custom headers" and add the headers below to authenticate on the LLM Proxy and attribute the client. This is in addition to the API key above, which Claude Desktop still needs.',
            showPassthroughKey: true,
            passthroughKeyAgentId: CLAUDE_DESKTOP_CLIENT_ID,
          },
        ],
      }),
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    sub: "AI code editor",
    svg: CURSOR_PATH,
    iconColor: "#1e1b4b",
    tileBg: "#fafaff",
    mcp: {
      kind: "custom",
      supportedAuth: "oauth",
      quick: true,
      configFile: "~/.cursor/mcp.json",
      language: "json",
      steps: [
        {
          title: "Open Cursor Customize",
          body: "Open Customize → MCPs → New MCP Server to edit mcp.json.",
        },
        {
          title: "Paste the config",
          body: "Drop the snippet into your mcpServers block and save.",
        },
        {
          title: "Enable the server",
          body: "Authenticate the server under Customize → MCPs. Its tools appear after sign-in.",
        },
      ],
      cta: {
        label: "Open in Cursor",
        buildHref: ({ url, serverName }) => {
          const cfg = btoa(JSON.stringify({ url }));
          return `cursor://anysphere.cursor-deeplink/mcp/install?name=${serverName}&config=${cfg}`;
        },
      },
      buildConfig: ({ url, token, serverName }) => {
        const entry: Record<string, unknown> = { url };
        if (token) entry.headers = { Authorization: `Bearer ${token}` };
        return JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2);
      },
    },
    proxy: {
      kind: "custom",
      supportedProviders: ["openai"],
      build: ({ url, tokenPlaceholder, appName }) => ({
        kind: "steps",
        steps: [
          {
            title: "Open Cursor Settings",
            body: "Cursor → Settings → Cursor Settings. In the left sidebar switch to Models.",
          },
          {
            title: "Open the OpenAI API Key panel",
            body: "Scroll to the API Keys section at the bottom and expand OpenAI API Key.",
          },
          {
            title: "Override the OpenAI Base URL",
            body: `Turn on "Override OpenAI Base URL" and paste ${url} into the field.`,
          },
          {
            title: "Enable the OpenAI API key",
            body: `Paste ${tokenPlaceholder} into the API Key field and turn on "Use OpenAI API Key". Supported OpenAI models then use ${appName}. A Cursor subscription cannot be used as a provider credential.`,
          },
        ],
      }),
    },
  },
  {
    id: "codex",
    label: NATIVE_SESSION_CLIENT_LABELS.codex,
    sub: "OpenAI CLI",
    ...markFields(OPENAI_MARK),
    mcp: {
      kind: "custom",
      supportedAuth: "oauth",
      configFile: "terminal",
      language: "bash",
      steps: [
        {
          title: "Register the gateway",
          body: "Codex opens your browser to complete the OAuth handshake automatically.",
          terminalTitle: "terminal",
          buildCommand: ({ url, serverName }) =>
            `codex mcp add ${shellArg(serverName)} --url ${shellArg(url)}`,
        },
      ],
    },
    proxy: {
      kind: "custom",
      supportedProviders: ["openai"],
      build: ({ appName }) => ({
        kind: "steps",
        steps: [
          {
            title: `Run the ${appName} setup command`,
            body: "The setup selects the proxy and adds your personal access header. Codex can use its existing ChatGPT login or an OpenAI API key.",
          },
        ],
      }),
    },
  },
  openCodeFamilyTile(OPENCODE_FAMILY.opencode, {
    mcpAddNote: " Needs OpenCode 1.17 or later.",
  }),

  openCodeFamilyTile(OPENCODE_FAMILY.kilo),

  {
    id: "copilot-cli",
    label: "Copilot CLI",
    sub: "GitHub coding CLI",
    svg: COPILOT_PATH,
    iconColor: "#24292f",
    tileBg: "#f6f8fa",
    mcp: {
      kind: "custom",
      supportedAuth: "both",
      preferredAuth: "oauth",
      configFile: "terminal",
      language: "bash",
      steps: ({ token }) => [
        {
          title: "Add the gateway",
          body: token
            ? "Use the static token when you want Copilot to call the MCP gateway without an OAuth browser flow."
            : "Copilot opens your browser when the gateway asks it to complete OAuth.",
          terminalTitle: "terminal",
          buildCommand: ({ url, serverName, token }) =>
            token
              ? `copilot mcp add --transport http --header ${shellArg(`Authorization: Bearer ${token}`)} ${shellArg(serverName)} ${shellArg(url)}`
              : `copilot mcp add --transport http ${shellArg(serverName)} ${shellArg(url)}`,
        },
        {
          title: "Verify the server",
          terminalTitle: "terminal",
          buildCommand: ({ serverName }) =>
            `copilot mcp get ${shellArg(serverName)}`,
        },
      ],
    },
    proxy: {
      kind: "custom",
      supportedProviders: [
        "openai",
        "azure",
        "openrouter",
        "vllm",
        "ollama",
        "groq",
        "mistral",
        "deepseek",
        "xai",
        "cerebras",
        "github-copilot",
      ],
      build: ({ provider, providerLabel, url, appName }) => ({
        kind: "steps",
        steps: [
          ...(provider === "github-copilot"
            ? [
                {
                  title: "Get your GitHub OAuth token",
                  body: 'GitHub Copilot has no static API keys — the proxy authenticates upstream with the GitHub OAuth token of an account that has a Copilot subscription. The Copilot CLI stores one in ~/.config/github-copilot/apps.json ("oauth_token"); the generated setup script obtains it for you automatically (reusing that file or running the GitHub sign-in flow).',
                },
              ]
            : []),
          {
            title: "Export Copilot provider settings",
            body:
              provider === "github-copilot"
                ? 'COPILOT_PROVIDER_TYPE stays "openai" because Copilot speaks the OpenAI-compatible protocol; the API key is your GitHub OAuth token (or a virtual key mapped to a stored GitHub Copilot key).'
                : `Use a virtual key mapped to ${providerLabel}. COPILOT_PROVIDER_TYPE stays "openai" because Copilot is speaking the OpenAI-compatible protocol; the ${appName} base URL still needs the selected provider path.`,
            language: "bash" as const,
            // The `<your-archestra-virtual-key>` placeholder and the
            // `archestra-copilot-cli-ok` echo sentinel below are wire-level
            // probe strings inside code blocks, not prose — they stay stable
            // across brands (and lowercase, so the white-label copy check
            // ignores them by design).
            code: `export COPILOT_PROVIDER_TYPE="openai"
export COPILOT_PROVIDER_BASE_URL="${url}"
export COPILOT_PROVIDER_API_KEY="${provider === "github-copilot" ? "<your-github-oauth-token>" : "<your-archestra-virtual-key>"}"
export COPILOT_MODEL="<model-name>"`,
          },
          {
            title: "Verify the proxy",
            language: "bash" as const,
            code: `copilot -p "Reply with exactly: archestra-copilot-cli-ok"`,
          },
        ],
      }),
    },
  },
  {
    id: "n8n",
    label: "n8n",
    sub: "Workflow automation",
    svg: N8N_PATH,
    iconColor: "#ea4b71",
    tileBg: "#fff1ec",
    mcp: {
      kind: "custom",
      supportedAuth: "both",
      preferredAuth: "token",
      configFile: "n8n workflow",
      language: "bash",
      steps: ({ token }) => {
        const addNode: ClientStep = {
          title: 'Add the "MCP Client Tool" node',
          body: "From the AI nodes panel in your AI Agent workflow.",
        };
        const setEndpoint: ClientStep = {
          title: "Paste the Endpoint",
          terminalTitle: "Endpoint",
          buildCommand: ({ url }) => url,
        };
        const verifyTools: ClientStep = {
          title: "Verify tools load",
          body: 'Set "Tools to Include" to "Selected", confirm the tools appear, then switch back to "All".',
        };
        const saveAndClose: ClientStep = {
          title: "Save and close",
        };

        if (token) {
          return [
            addNode,
            setEndpoint,
            {
              title: 'Set Authentication to "Bearer Auth"',
              body: "Create a credential and paste the value below.",
              showAuthHeader: true,
              authHeaderBare: true,
            },
            verifyTools,
            saveAndClose,
          ];
        }
        return [
          addNode,
          setEndpoint,
          {
            title: 'Set Authentication to "MCP OAuth2"',
          },
          {
            title: "Create the MCP OAuth2 credential",
            body: 'Click "Credential for MCP OAuth2 API" → "Create new credential". Paste the value below into "Server URL" and Save.',
            terminalTitle: "Server URL",
            buildCommand: ({ url }) => url,
          },
          verifyTools,
          saveAndClose,
        ];
      },
    },
    proxy: {
      kind: "custom",
      supportedProviders: [
        "openai",
        "anthropic",
        "bedrock",
        "gemini",
        "mistral",
        "groq",
        "cerebras",
        "perplexity",
        "xai",
        "openrouter",
        "vllm",
        "ollama",
        "deepseek",
        "kimi",
        "cohere",
        "zhipuai",
        "minimax",
        "azure",
        "github-copilot",
      ],
      build: ({ provider, providerLabel, url, tokenPlaceholder, appName }) => {
        if (provider === "bedrock") {
          // `url` is the id-less Bedrock route (…/v1/bedrock); the OpenAI-compatible
          // variant nests under it.
          const openaiUrl = `${url}/openai`;
          return {
            kind: "steps",
            note: "n8n doesn't currently support Bedrock API keys, so the native AWS Bedrock node can't be used here. Route through the OpenAI-compatible endpoint instead.",
            steps: [
              {
                title: 'Add an "OpenAI Chat Model" node',
                body: `In your AI Agent workflow, add the "OpenAI Chat Model" node. ${appName} exposes Bedrock through an OpenAI-compatible URL.`,
              },
              {
                title: "Create new OpenAI credentials",
                body: 'In the node\'s "Credential to connect with" dropdown, click "Create new credential" to open the credential editor.',
              },
              {
                title: "Fill in the credential",
                body: 'Paste the values below into the "API Key" and "Base URL" fields, then click "Save".',
                fields: [
                  {
                    label: "API Key",
                    value: tokenPlaceholder,
                    copyable: false,
                  },
                  { label: "Base URL", value: openaiUrl },
                ],
              },
              {
                title: "Pick a model and run",
                body: 'Select a Bedrock model in the node\'s "Model" dropdown and execute the workflow.',
              },
            ],
          };
        }
        if (provider === "anthropic") {
          return {
            kind: "steps",
            steps: [
              {
                title: 'Add an "Anthropic Chat Model" node',
                body: 'In your AI Agent workflow, add the "Anthropic Chat Model" node from the AI nodes panel.',
              },
              {
                title: "Create new Anthropic credentials",
                body: 'In the node\'s "Credential to connect with" dropdown, click "Create new credential" to open the credential editor.',
              },
              {
                title: "Fill in the credential",
                body: 'Paste the values below into the "API Key" and "Base URL" fields, then click "Save".',
                fields: [
                  {
                    label: "API Key",
                    value: tokenPlaceholder,
                    copyable: false,
                  },
                  { label: "Base URL", value: url },
                ],
              },
              {
                title: "Pick a model and run",
                body: 'Select an Anthropic model in the node\'s "Model" dropdown and execute the workflow.',
              },
            ],
          };
        }
        if (provider === "gemini") {
          return {
            kind: "steps",
            steps: [
              {
                title: 'Add a "Google Gemini Chat Model" node',
                body: 'In your AI Agent workflow, add the "Google Gemini Chat Model" node.',
              },
              {
                title: "Create new Google Gemini(PaLM) credentials",
                body: 'In the node\'s "Credential to connect with" dropdown, click "Create new credential" to open the credential editor.',
              },
              {
                title: "Fill in the credential",
                body: 'Paste the values below into the "API Key" and "Host" fields, then click "Save".',
                fields: [
                  {
                    label: "API Key",
                    value: tokenPlaceholder,
                    copyable: false,
                  },
                  { label: "Host", value: url },
                ],
              },
              {
                title: "Pick a model and run",
                body: "Select a Gemini model in the node and execute the workflow.",
              },
            ],
          };
        }
        return {
          kind: "steps",
          steps: [
            {
              title: 'Add an "OpenAI Chat Model" node',
              body:
                provider === "openai"
                  ? 'In your AI Agent workflow, add the "OpenAI Chat Model" node from the AI nodes panel.'
                  : `In your AI Agent workflow, add the "OpenAI Chat Model" node. ${appName} exposes ${providerLabel} as an OpenAI-compatible endpoint, so the OpenAI node is the right one.`,
            },
            {
              title: "Create new OpenAI credentials",
              body: 'In the node\'s "Credential to connect with" dropdown, click "Create new credential" to open the credential editor.',
            },
            {
              title: "Fill in the credential",
              body: 'Paste the values below into the "API Key" and "Base URL" fields, then click "Save".',
              fields: [
                {
                  label: "API Key",
                  value: tokenPlaceholder,
                  copyable: false,
                },
                { label: "Base URL", value: url },
              ],
            },
            {
              title: "Pick a model and run",
              body: `Select a ${providerLabel} model in the node's "Model" dropdown and execute the workflow.`,
            },
          ],
        };
      },
    },
  },
  {
    id: "pi",
    label: "Pi",
    sub: "Open-source coding CLI",
    ...markFields(PI_MARK),
    mcp: {
      kind: "custom",
      supportedAuth: "oauth",
      configFile: "~/.pi/agent/mcp.json",
      language: "json",
      steps: [
        {
          title: "Install Pi 1.4 or later",
          body: "Install @earendil-works/pi-coding-agent with pnpm, then use the setup command on this page. Include both tools and the LLM proxy.",
          buildCommand: () => "pnpm add -g @earendil-works/pi-coding-agent",
          language: "bash",
        },
        {
          title: "Sign in to the gateway",
          body: "The installer adds direct MCP tools and the native guardrails extension. Complete the browser sign-in before starting Pi.",
          buildCommand: ({ serverName }) =>
            `pi mcp login ${shellArg(serverName)}`,
          language: "bash",
        },
      ],
    },
    proxy: {
      kind: "custom",
      supportedProviders: [...INSTALLER_CLIENT_KEY_PROVIDERS.pi],
      build: () => ({
        kind: "steps",
        steps: [
          {
            title: "Run the connection setup",
            body: "Keep tools and the LLM proxy selected. The installer saves your authorized provider catalog and installs the native guardrails extension, shared skills and arcpi launcher.",
          },
          {
            title: "Start Pi with guardrails",
            code: "arcpi",
            language: "bash",
            body: "Native tools and compaction use the same policy session as model requests. Tree navigation and summaries retain the policy session. Nested tool execution remains blocked. Use Pi’s /model picker to switch among the connected providers and models. Providers outside this connection remain blocked.",
          },
        ],
      }),
    },
  },
  ...POPULAR_GENERIC_CLIENTS.map(
    (client): ConnectClient => ({
      ...client,
      svgFillRule:
        client.svgFillRule ?? (client.svgViewBox ? undefined : "evenodd"),
      mcp: { kind: "generic", supportedAuth: "both" },
      proxy: client.proxy ?? { kind: "generic" },
    }),
  ),
  {
    id: "generic",
    label: "Generic client",
    sub: "Generic instructions",
    tileBg: "#f1f1fa",
    iconOverride: { bg: "#1e1b4b", fg: "#fff", glyph: "⌘" },
    mcp: { kind: "generic", supportedAuth: "both" },
    proxy: { kind: "generic" },
  },
];

export function orderedClients(
  order: readonly string[] | null | undefined,
): ConnectClient[] {
  const remaining = new Map(
    CONNECT_CLIENTS.map((client) => [client.id, client]),
  );
  const clients: ConnectClient[] = [];
  for (const id of order ?? []) {
    const client = remaining.get(id);
    if (!client || id === "generic") continue;
    clients.push(client);
    remaining.delete(id);
  }
  return [...clients, ...remaining.values()];
}

/** Null visibility shows all clients; Generic client is always included. */
export function visibleClients(
  shownIds: readonly string[] | null | undefined,
  order?: readonly string[] | null,
): ConnectClient[] {
  const clients = orderedClients(order);
  if (!shownIds) return clients;
  const shown = new Set(shownIds);
  return clients.filter((c) => c.id === "generic" || shown.has(c.id));
}

export function usesGenericInstructions(client: ConnectClient): boolean {
  return client.mcp.kind === "generic";
}

// Apps with an installer: the one shared list the installer, connect.md and
// disconnect.md read too.
export {
  type InstallerClientId,
  isInstallerClientId,
} from "@archestra/shared/connection-setup";

// === Internal helpers ===

/**
 * Single-quote a value for safe pasting into a POSIX shell, mirroring the
 * backend setup script's `sh()`. A gateway name is member-editable free text,
 * so metacharacters (`$()`, backticks, `;`, `|`) must not break out of the
 * generated copy-paste command into the user's shell.
 */
function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * OpenCode and Kilo Code share one tile: the same `mcp` commands, the same
 * manual proxy snippet and the mark, from the family descriptor. Only a
 * version note differs.
 */
function openCodeFamilyTile(
  client: OpenCodeFamilyDescriptor,
  { mcpAddNote = "" }: { mcpAddNote?: string } = {},
): ConnectClient {
  const { binary, label, mark } = client;
  const siblingConfigFile =
    client.manualConfigFile === client.configFile
      ? client.commentedConfigFile
      : client.configFile;
  return {
    id: client.id,
    label,
    sub: "Open-source CLI",
    ...markFields(mark),
    mcp: {
      kind: "custom",
      supportedAuth: "both",
      preferredAuth: "oauth",
      configFile: "terminal",
      language: "bash",
      steps: ({ token }) => {
        const verifyServer: ClientStep = {
          title: "Check the connection",
          body: 'The gateway should be listed as "connected".',
          terminalTitle: "terminal",
          buildCommand: () => `${binary} mcp list`,
        };
        if (token) {
          return [
            {
              title: "Add the gateway",
              body: `Use the static token when you want ${label} to call the MCP gateway without an OAuth browser flow.${mcpAddNote}`,
              terminalTitle: "terminal",
              buildCommand: ({ url, serverName, token }) =>
                `${binary} mcp add ${shellArg(serverName)} --url ${shellArg(url)} --header ${shellArg(`Authorization=Bearer ${token}`)}`,
            },
            verifyServer,
          ];
        }
        return [
          {
            title: "Add the gateway",
            body: `Registers the gateway in your global ${label} config.${mcpAddNote}`,
            terminalTitle: "terminal",
            buildCommand: ({ url, serverName }) =>
              `${binary} mcp add ${shellArg(serverName)} --url ${shellArg(url)}`,
          },
          {
            title: "Start the OAuth flow",
            body: `Check with ${binary} mcp list first. Run this only if authentication is needed; ${label} does not start OAuth on its own.`,
            terminalTitle: "terminal",
            buildCommand: ({ serverName }) =>
              `${binary} mcp auth ${shellArg(serverName)}`,
          },
          {
            title: FINISH_OAUTH_FLOW_TITLE,
            body: `${label} opens your browser and prints the sign-in link. Sign in and approve the gateway — it grants tool access per user, so its tools stay unavailable until you complete this one-time sign-in.`,
          },
          verifyServer,
        ];
      },
    },
    proxy: {
      kind: "custom",
      supportedProviders: OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map(
        ({ provider }) => provider,
      ),
      build: ({ provider, url, appName }) => {
        const rootUrl = url.replace(new RegExp(`/${provider}$`), "");
        const selectedRoute = OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.find(
          (route) => route.provider === provider,
        );
        const selectedProviderId =
          selectedRoute?.openCodeProviderId ?? provider;
        const selectedBaseUrl = selectedRoute
          ? openCodePassthroughBaseUrl(rootUrl, selectedRoute)
          : url;
        return {
          kind: "steps",
          steps: [
            {
              title: `Open ~/.config/${client.dir}/${client.manualConfigFile}`,
              body: `Create it if it doesn't exist. If you have ${siblingConfigFile} there instead, edit that file.`,
            },
            {
              title: `Route ${selectedProviderId} through ${appName}`,
              body: `Merge this snippet into the file. It keeps the native provider and model ids and uses the credential already configured for this provider. ${label} then offers only this provider, so no request skips ${appName}.`,
              language: "json",
              code: JSON.stringify(
                {
                  enabled_providers: [selectedProviderId],
                  provider: {
                    [selectedProviderId]: {
                      options: {
                        baseURL: selectedBaseUrl,
                        headers: { [EXTERNAL_AGENT_ID_HEADER]: client.id },
                      },
                    },
                  },
                },
                null,
                2,
              ),
            },
            {
              title: "Verify the proxy",
              body: `Pick an existing model under ${selectedProviderId}. The request must appear in the ${appName} LLM logs with the ${label} badge.`,
              language: "bash",
              code: `${binary} run -m ${selectedProviderId}/<model-id> "Reply with exactly: ${client.id}-proxy-ok"`,
            },
          ],
        };
      },
    },
  };
}
