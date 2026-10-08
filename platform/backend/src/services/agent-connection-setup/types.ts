import type { SupportedProvider } from "@archestra/shared";
import type {
  ConnectionSetupClientId,
  ConnectionSetupPlatform,
  ConnectionSetupProxyAuth,
} from "@/types";

export interface SetupScriptMcpSection {
  /** Logical server name registered in the client (slug). */
  serverName: string;
  /** Prefix advertised by this deployment's built-in MCP tools. */
  toolPrefix: string;
  /**
   * Names an earlier connect run registered this same gateway under. A re-run
   * moves such an entry onto `serverName`, so one gateway never shows up twice
   * in the client's server list. Empty when nothing needs migrating.
   */
  legacyServerNames?: string[];
  /** Gateway URL, e.g. https://host/v1/mcp/<gateway-slug>. */
  url: string;
}

export interface SetupScriptProxySection {
  /**
   * "provider-key" (passthrough): only the base URL is rewired and the user
   * keeps their own provider credentials — virtualKey/virtualKeyName are
   * null. "virtual-key": the auto-provisioned key below is injected.
   */
  authMode: ConnectionSetupProxyAuth;
  provider: SupportedProvider;
  providerLabel: string;
  /** Browser-facing LLM proxy root before the provider path. */
  baseUrl: string;
  /** Proxy URL, e.g. https://host/v1/anthropic/<profile-id>. */
  url: string;
  /** Slug of the LLM proxy name — provider id in client configs. */
  proxyName: string;
  /** Raw virtual key value injected at render time (virtual-key mode only). */
  virtualKey: string | null;
  /** Display name of the virtual key, for revocation guidance. */
  virtualKeyName: string | null;
  /**
   * Raw passthrough virtual key value injected at render time, sent as the
   * X-Archestra-Virtual-Key header so the proxy attributes the request to the
   * user. Set only in passthrough (provider-key) mode for the Anthropic
   * provider (Claude Code subscription passthrough); null otherwise. Orthogonal
   * to `virtualKey` — it carries no provider credential.
   */
  passthroughVirtualKey: string | null;
  /**
   * Model the wizard's review step selected for clients that require or persist
   * one. Null leaves model selection to the client/provider.
   */
  model: string | null;
  /**
   * GitHub OAuth endpoints for the in-script device flow. Required when
   * provider is "github-copilot" in passthrough mode: Copilot has no static
   * API keys, so the script obtains the user's GitHub OAuth token locally
   * (reusing the Copilot CLI's stored token when one works, otherwise running
   * the device flow) and the token never leaves the machine.
   */
  githubCopilot?: {
    /** Exchange endpoint used to verify a token has an active Copilot seat. */
    tokenExchangeUrl: string;
    /** Host serving /login/device/code and /login/oauth/access_token. */
    deviceAuthBaseUrl: string;
    /** GitHub App client id for the device flow. */
    clientId: string;
  } | null;
}

export interface SetupScriptSkillsSection {
  cloneUrl: string;
  marketplaceName: string;
  /** Existing skills plugin is present. Defaults true for older callers/tests. */
  hasSkills?: boolean;
  /** Opaque hook-bearing plugin entries advertised by the same marketplace. */
  pluginNames?: string[];
}

export interface SetupScriptContext {
  clientId: ConnectionSetupClientId;
  /** Target OS: "macos"/"linux" render bash, "windows" renders PowerShell. */
  platform: ConnectionSetupPlatform;
  /** White-label product name for user-facing messaging. */
  appName: string;
  /**
   * Trusted built-in tool prefix from deployment branding. Independent of
   * `mcp.serverName`; the canonical prefix is omitted from printed options.
   */
  toolPrefix?: string;
  mcp: SetupScriptMcpSection | null;
  proxy: SetupScriptProxySection | null;
  skills: SetupScriptSkillsSection | null;
  /** Copied locally by setup, never fetched from the platform at launch. */
  runtimeHandoffInstructions?: string | null;
}

/** One script language's renderer for an agent. */
export interface AgentScriptRenderer {
  /** Setup steps, in order, between the shared header and footer. */
  sections(ctx: SetupScriptContext): string[];
  /** Numbered next steps printed by the shared footer. */
  nextSteps(ctx: SetupScriptContext): string[];
}

/**
 * An agent whose setup is a rendered shell script: bash for macOS/Linux and
 * PowerShell for Windows.
 */
export interface ShellAgentSetup {
  /** Client name shown in the script header and banner. */
  label: string;
  /** CLI the script requires on PATH before it changes anything. */
  binary?: string;
  bash: AgentScriptRenderer;
  powerShell: AgentScriptRenderer;
}
