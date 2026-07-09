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
 *
 * `plugins.marketplaces` registers the org's shared skills as a git-backed
 * plugin marketplace; Claude Desktop surfaces it in the Directory's
 * Organization tab, where the user installs the skills. The clone URL embeds a
 * one-time share token, so it is a secret on par with the inference keys.
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
  plugins?: {
    marketplaces: Array<{
      source: "git";
      url: string;
      // Rejects the clone if the repo's manifest name differs, so an upstream
      // rename can't silently swap in another marketplace.
      expectedName: string;
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
  /** Shared-skills marketplace to register; omitted when skills aren't included. */
  skillMarketplace?: { cloneUrl: string; marketplaceName: string } | null;
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

  if (input.skillMarketplace) {
    profile.plugins = {
      marketplaces: [
        {
          source: "git",
          url: input.skillMarketplace.cloneUrl,
          expectedName: input.skillMarketplace.marketplaceName,
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
 * headers), the static API credential, and the token-bearing marketplace clone
 * URL are replaced with a mask. The real values only ever leave via the
 * downloaded file.
 */
export function maskConfigSecrets(
  profile: ClaudeDesktopConfigProfile,
): ClaudeDesktopConfigProfile {
  const masked: ClaudeDesktopConfigProfile = {
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

  if (profile.plugins) {
    masked.plugins = {
      // The clone URL embeds a share token; the marketplace name is not secret.
      marketplaces: profile.plugins.marketplaces.map((m) => ({
        ...m,
        url: SECRET_MASK,
      })),
    };
  }

  return masked;
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
