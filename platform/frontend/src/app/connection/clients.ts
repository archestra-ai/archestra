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
const N8N_PATH =
  "M21.4737 5.6842c-1.1772 0-2.1663.8051-2.4468 1.8947h-2.8955c-1.235 0-2.289.893-2.492 2.111l-.1038.623a1.263 1.263 0 0 1-1.246 1.0555H11.289c-.2805-1.0896-1.2696-1.8947-2.4468-1.8947s-2.1663.8051-2.4467 1.8947H4.973c-.2805-1.0896-1.2696-1.8947-2.4468-1.8947C1.1311 9.4737 0 10.6047 0 12s1.131 2.5263 2.5263 2.5263c1.1772 0 2.1663-.8051 2.4468-1.8947h1.4223c.2804 1.0896 1.2696 1.8947 2.4467 1.8947 1.1772 0 2.1663-.8051 2.4468-1.8947h1.0008a1.263 1.263 0 0 1 1.2459 1.0555l.1038.623c.203 1.218 1.257 2.111 2.492 2.111h.3692c.2804 1.0895 1.2696 1.8947 2.4468 1.8947 1.3952 0 2.5263-1.131 2.5263-2.5263s-1.131-2.5263-2.5263-2.5263c-1.1772 0-2.1664.805-2.4468 1.8947h-.3692a1.263 1.263 0 0 1-1.246-1.0555l-.1037-.623A2.52 2.52 0 0 0 13.9607 12a2.52 2.52 0 0 0 .821-1.4794l.1038-.623a1.263 1.263 0 0 1 1.2459-1.0555h2.8955c.2805 1.0896 1.2696 1.8947 2.4468 1.8947 1.3952 0 2.5263-1.131 2.5263-2.5263s-1.131-2.5263-2.5263-2.5263m0 1.2632a1.263 1.263 0 0 1 1.2631 1.2631 1.263 1.263 0 0 1-1.2631 1.2632 1.263 1.263 0 0 1-1.2632-1.2632 1.263 1.263 0 0 1 1.2632-1.2631M2.5263 10.7368A1.263 1.263 0 0 1 3.7895 12a1.263 1.263 0 0 1-1.2632 1.2632A1.263 1.263 0 0 1 1.2632 12a1.263 1.263 0 0 1 1.2631-1.2632m6.3158 0A1.263 1.263 0 0 1 10.1053 12a1.263 1.263 0 0 1-1.2632 1.2632A1.263 1.263 0 0 1 7.579 12a1.263 1.263 0 0 1 1.2632-1.2632m10.1053 3.7895a1.263 1.263 0 0 1 1.2631 1.2632 1.263 1.263 0 0 1-1.2631 1.2631 1.263 1.263 0 0 1-1.2632-1.2631 1.263 1.263 0 0 1 1.2632-1.2632";
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
            kind: "steps",
            steps: [
              {
                title: "Open ~/.claude/settings.local.json",
                body: "Create the file if it doesn't exist.",
              },
              {
                title: "Add the Bedrock proxy settings to env",
                body: "Merge the snippet below into the file (keep your existing keys). Update AWS_REGION if you use a different one.",
                language: "json",
                code: `{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "us-east-1",
    "ANTHROPIC_BEDROCK_BASE_URL": "${url}"
  }
}`,
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
              title: "Open ~/.claude/settings.local.json",
              body: "Create the file if it doesn't exist.",
            },
            {
              title: "Add the Archestra base URL to env",
              body: "Merge the snippet below into the file (keep your existing keys). Your Claude subscription keeps working as-is.",
              language: "json",
              code: `{
  "env": {
    "ANTHROPIC_BASE_URL": "${url}"
  }
}`,
            },
            {
              title: "Restart Claude Code",
              body: "New sessions will route through Archestra automatically.",
            },
          ],
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
        "cohere",
        "zhipuai",
        "minimax",
        "azure",
      ],
      build: ({ provider, providerLabel, url, tokenPlaceholder }) => {
        if (provider === "bedrock") {
          const openaiUrl = url.replace("/bedrock/", "/bedrock/openai/");
          return {
            kind: "steps",
            note: "n8n doesn't currently support Bedrock API keys, so the native AWS Bedrock node can't be used here. Route through the OpenAI-compatible endpoint instead.",
            steps: [
              {
                title: 'Add an "OpenAI Chat Model" node',
                body: 'In your AI Agent workflow, add the "OpenAI Chat Model" node. Archestra exposes Bedrock through an OpenAI-compatible URL.',
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
                  : `In your AI Agent workflow, add the "OpenAI Chat Model" node. Archestra exposes ${providerLabel} as an OpenAI-compatible endpoint, so the OpenAI node is the right one.`,
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
    id: "generic",
    label: "Any Client",
    sub: "Generic instructions",
    tileBg: "#f1f1fa",
    iconOverride: { bg: "#1e1b4b", fg: "#fff", glyph: "⌘" },
    mcp: { kind: "generic", supportedAuth: "both" },
    proxy: { kind: "generic" },
  },
];
