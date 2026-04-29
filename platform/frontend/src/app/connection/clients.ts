import type { SupportedProvider } from "@shared";

export interface ClientStep {
  title: string;
  body?: string;
  /** Optional per-step command, rendered in an inline terminal beneath the step. */
  buildCommand?: (params: McpBuildParams) => string;
  /** Language for this step's terminal. Falls back to the parent `language`. */
  language?: "json" | "toml" | "bash";
  /** Title for this step's terminal. Falls back to the parent `configFile`. */
  terminalTitle?: string;
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
       * When true, the client exposes a working deeplink — we show only the
       * one-click CTA and hide the manual steps + config block. Requires `cta`.
       */
      quick?: boolean;
      /** Shown in the "config file" label above the code block. */
      configFile: string;
      /** Language hint for syntax highlighting. */
      language: "json" | "toml" | "bash";
      steps: ClientStep[];
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
}

/** A proxy step — either descriptive (title/body) or with a copyable code block beneath it. */
export interface ProxyStep {
  title: string;
  body?: string;
  /** Pre-rendered code for this step's terminal block. */
  code?: string;
  language?: "json" | "toml" | "bash";
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
  iconColor?: string;
  tileBg?: string;
  iconOverride?: { bg: string; fg: string; glyph: string };
  mcp: McpSupport;
  proxy: ProxySupport;
}

const CLAUDE_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const CURSOR_PATH =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";
export const CONNECT_CLIENTS: ConnectClient[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    sub: "Anthropic CLI",
    svg: CLAUDE_PATH,
    iconColor: "#D97757",
    tileBg: "#fff1ea",
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
            `claude mcp add --transport http ${serverName} ${url}`,
        },
        {
          title:
            "Open Claude and run /mcp. Select the gateway you just added and kick off the OAuth flow.",
          terminalTitle: "terminal",
          buildCommand: () => "claude /mcp",
        },
        {
          title: "Finish the OAuth flow",
          body: "Claude Code opens your browser. Sign in and approve the gateway.",
        },
      ],
    },
    proxy: {
      kind: "custom",
      supportedProviders: ["anthropic", "bedrock"],
      build: ({ provider, url, tokenPlaceholder }) => {
        if (provider === "bedrock") {
          return {
            kind: "snippet",
            language: "bash",
            code: `# Route Claude Code through Archestra (Bedrock backend)
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_BEDROCK_BASE_URL="${url}"
export AWS_BEARER_TOKEN_BEDROCK="${tokenPlaceholder}"
claude`,
          };
        }
        return {
          kind: "snippet",
          language: "bash",
          code: `# Route Claude Code through Archestra
export ANTHROPIC_BASE_URL="${url}"
export ANTHROPIC_API_KEY="${tokenPlaceholder}"
claude`,
        };
      },
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
          title: "Open Cursor settings",
          body: "Cmd ⌘ + , → MCP → Edit mcp.json.",
        },
        {
          title: "Paste the config",
          body: "Drop the snippet into your mcpServers block and save.",
        },
        {
          title: "Enable the server",
          body: "Toggle the server on under MCP Servers. Tools appear in the @-mention menu.",
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
      build: ({ url, tokenPlaceholder }) => ({
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
            title: "Paste your key and verify",
            body: `Paste ${tokenPlaceholder} into the API Key field, then click Verify. Cursor now routes every OpenAI-compatible model through Archestra.`,
          },
        ],
      }),
    },
  },
  {
    id: "codex",
    label: "Codex",
    sub: "OpenAI CLI",
    svg: OPENAI_PATH,
    iconColor: "#10a37f",
    tileBg: "#eaf7f1",
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
            `codex mcp add ${serverName} --url ${url}`,
        },
      ],
    },
    proxy: {
      kind: "custom",
      supportedProviders: ["openai"],
      build: ({ url, proxyName }) => ({
        kind: "steps",
        steps: [
          {
            title: "Sign in to Codex with an API key",
            body: "Codex must be logged in with an OpenAI API key — ChatGPT-account login isn't supported through the proxy. The key is read from stdin.",
            language: "bash",
            code: `printenv OPENAI_API_KEY | codex login --with-api-key`,
          },
          {
            title: "Add the provider to ~/.codex/config.toml",
            language: "toml",
            code: `[model_providers.${proxyName}]
name = "${proxyName}"
base_url = "${url}"
wire_api = "responses"
requires_openai_auth = true`,
          },
          {
            title: "Run Codex through it",
            language: "bash",
            code: `codex -c model_provider=${proxyName}`,
          },
        ],
      }),
    },
  },
  {
    id: "generic",
    label: "Any Client",
    sub: "Generic instructions",
    tileBg: "#f1f1fa",
    iconOverride: { bg: "#1e1b4b", fg: "#fff", glyph: "⌘" },
    mcp: { kind: "generic", supportedAuth: "both" },
    proxy: { kind: "generic" },
  },
];
