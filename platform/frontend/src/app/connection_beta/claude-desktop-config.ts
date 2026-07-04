import {
  CLAUDE_DESKTOP_CLIENT_ID,
  EXTERNAL_AGENT_ID_HEADER,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";

/**
 * The Archestra configuration profile Claude Desktop imports from its
 * "Configure Third-Party Inference" screen ("Default" dropdown → "Import
 * configuration…"). The `$schemaVersion: 2` shape is owned by Claude Desktop;
 * keep it in sync with what that importer accepts.
 *
 * `inference` carries both credentials: the passthrough virtual key rides in the
 * `X-Archestra-Virtual-Key` custom header (authenticates the Archestra user on
 * the LLM Proxy), while the standard virtual key — minted from the Anthropic
 * provider key — is the static API key used for the upstream call.
 */
export interface ClaudeDesktopConfigProfile {
  $schemaVersion: 2;
  inference: {
    provider: "gateway";
    baseUrl: string;
    customHeaders: Record<string, string>;
    credential: { kind: "static"; apiKey: string };
  };
  mcp?: {
    managedServers: Array<{
      name: string;
      transport: "http";
      url: string;
      oauth: { mode: "dcr" };
      source: "user";
    }>;
  };
}

/**
 * Build the importable profile. `baseUrl` already includes the `/v1` segment, so
 * the inference endpoint uses the proxy **id** and the MCP server uses the
 * gateway **slug** — matching how the rest of the connect page builds URLs.
 * The `mcp` block is omitted when no gateway is provided.
 */
export function buildClaudeDesktopConfigProfile(input: {
  baseUrl: string;
  llmProxyId: string;
  passthroughKey: string;
  virtualKey: string;
  gateway?: { slug: string; name: string } | null;
}): ClaudeDesktopConfigProfile {
  const profile: ClaudeDesktopConfigProfile = {
    $schemaVersion: 2,
    inference: {
      provider: "gateway",
      baseUrl: `${input.baseUrl}/anthropic/${input.llmProxyId}`,
      customHeaders: {
        [EXTERNAL_AGENT_ID_HEADER]: CLAUDE_DESKTOP_CLIENT_ID,
        [VIRTUAL_KEY_HEADER]: input.passthroughKey,
      },
      credential: { kind: "static", apiKey: input.virtualKey },
    },
  };

  if (input.gateway) {
    profile.mcp = {
      managedServers: [
        {
          // Claude Desktop namespaces every managed server; match the gateway id
          // used in the URL (the slug) under an archestra-mcp- prefix so the
          // server name is recognizable and lines up with its endpoint.
          name: `archestra-mcp-${input.gateway.slug}`,
          transport: "http",
          url: `${input.baseUrl}/mcp/${input.gateway.slug}`,
          oauth: { mode: "dcr" },
          source: "user",
        },
      ],
    };
  }

  return profile;
}

/** Mask shown in place of a secret value in the on-screen preview. */
const SECRET_MASK = "•".repeat(20);

/**
 * A copy of the profile safe to render on screen: the passthrough key (custom
 * headers) and the static API credential are replaced with a mask. The real
 * values only ever leave via the downloaded file.
 */
export function maskConfigSecrets(
  profile: ClaudeDesktopConfigProfile,
): ClaudeDesktopConfigProfile {
  return {
    ...profile,
    inference: {
      ...profile.inference,
      // Mask only the secret header(s); the agent-id attribution header is not
      // a secret, so it stays visible in the on-screen preview.
      customHeaders: Object.fromEntries(
        Object.entries(profile.inference.customHeaders).map(
          ([header, value]) => [
            header,
            header === EXTERNAL_AGENT_ID_HEADER ? value : SECRET_MASK,
          ],
        ),
      ),
      credential: { ...profile.inference.credential, apiKey: SECRET_MASK },
    },
  };
}

/** Mirrors the connection-setup script token prefix. */
const CONFIG_FILENAME_PREFIX = "archestra_con_";

/**
 * Opaque file name for the downloaded profile, e.g.
 * `archestra_con_NpIH_aGz4niR86Yfdc8vKjwktjLDeD7l`. A fresh random token every
 * call (regenerated on each download) so the file name leaks no org/user/proxy
 * details — same shape as the connection-setup script tokens.
 */
export function generateConfigFilename(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${CONFIG_FILENAME_PREFIX}${token}`;
}

/** Trigger a browser download of the profile as pretty-printed JSON. */
export function downloadClaudeDesktopConfig(
  profile: ClaudeDesktopConfigProfile,
  filename: string,
): void {
  const blob = new Blob([JSON.stringify(profile, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
