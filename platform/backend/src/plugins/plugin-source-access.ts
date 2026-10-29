import {
  DEFAULT_GIT_WEB_URLS,
  type GitHost,
  type GitProvider,
  gitHostFromUrl,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import {
  type GitAccess,
  resolveGitCredentialAccess,
  resolveGitSourceAccess,
} from "@/git-hosts/git-access";
import { ApiError, type Plugin } from "@/types";

/** How a request authenticates to a plugin repository; at most one is set. */
export interface PluginGitAuth {
  /** Git host of a public repository; ignored when a credential is given. */
  provider?: GitProvider;
  /** One-time github.com token, never stored. */
  githubToken?: string;
  githubAppConfigId?: string;
  githubPatId?: string;
  gitlabTokenId?: string;
}

type PluginSourceFields = Pick<
  Plugin,
  | "organizationId"
  | "sourceProvider"
  | "sourceOrigin"
  | "githubAppConfigId"
  | "githubPatId"
  | "gitlabTokenId"
>;

export function hasSinglePluginGitAuth(auth: PluginGitAuth): boolean {
  return (
    [
      auth.githubToken,
      auth.githubAppConfigId,
      auth.githubPatId,
      auth.gitlabTokenId,
    ].filter(Boolean).length <= 1
  );
}

/**
 * The host and token a request reads with. A stored credential carries its
 * own host (GitHub Enterprise Server, self-managed GitLab) and needs
 * `credential:read`; otherwise the provider's cloud, with a transient
 * github.com token when one is given. Undefined means public github.com.
 */
export async function resolvePluginImportAccess(
  params: PluginGitAuth & { organizationId: string; userId: string },
): Promise<GitAccess | undefined> {
  const credentialId =
    params.githubAppConfigId ?? params.githubPatId ?? params.gitlabTokenId;
  if (!credentialId) {
    if (params.githubToken) {
      if (params.provider === "gitlab") {
        throw new ApiError(
          400,
          "githubToken only reads github.com; use a saved GitLab token",
        );
      }
      return {
        host: gitHostFromUrl({ provider: "github" }),
        token: params.githubToken,
      };
    }
    return params.provider === "gitlab"
      ? { host: gitHostFromUrl({ provider: "gitlab" }) }
      : undefined;
  }
  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "credential",
    "read",
  );
  if (!allowed) {
    throw new ApiError(403, "You do not have access to Git credentials");
  }
  const access = await resolveGitCredentialAccess({
    organizationId: params.organizationId,
    credentialId,
  });
  const expected = params.gitlabTokenId ? "gitlab" : "github";
  if (access.host.provider !== expected) {
    throw new ApiError(400, "That credential is for a different Git provider");
  }
  return access;
}

/**
 * Access for a stored plugin source: its saved credential, or public access
 * to the provider's cloud. The credential must belong to the source's host,
 * so a self-hosted source is only read through a credential for that host.
 */
export function resolvePluginSourceAccess(
  plugin: PluginSourceFields,
): Promise<GitAccess> {
  const provider = plugin.sourceProvider ?? "github";
  return resolveGitSourceAccess({
    organizationId: plugin.organizationId,
    provider,
    credentialId: storedCredentialId(plugin),
    origin: pluginSourceWebUrl(plugin),
  });
}

/** Refuse request-supplied access for a host other than the plugin's source. */
export function assertPluginSourceHost(params: {
  plugin: Pick<Plugin, "sourceProvider" | "sourceOrigin">;
  access: GitAccess | undefined;
}): void {
  const host = params.access?.host ?? gitHostFromUrl({ provider: "github" });
  const provider = params.plugin.sourceProvider ?? "github";
  if (
    host.provider !== provider ||
    host.webUrl !== pluginSourceWebUrl(params.plugin)
  ) {
    throw new ApiError(
      400,
      `That credential is for ${host.webUrl}, not the plugin's source at ${pluginSourceWebUrl(params.plugin)}`,
    );
  }
}

/** The host a plugin's source lives on. */
export function pluginSourceGitHost(
  plugin: Pick<Plugin, "sourceProvider" | "sourceOrigin">,
): GitHost {
  return gitHostFromUrl({
    provider: plugin.sourceProvider ?? "github",
    url: pluginSourceWebUrl(plugin),
  });
}

/** The single stored credential behind a source, if any. */
export function storedCredentialId(
  plugin: Pick<Plugin, "githubAppConfigId" | "githubPatId" | "gitlabTokenId">,
): string | null {
  return plugin.githubAppConfigId ?? plugin.gitlabTokenId ?? plugin.githubPatId;
}

// === Internal helpers ===

function pluginSourceWebUrl(
  plugin: Pick<Plugin, "sourceProvider" | "sourceOrigin">,
): string {
  return (
    plugin.sourceOrigin ??
    DEFAULT_GIT_WEB_URLS[plugin.sourceProvider ?? "github"]
  );
}
