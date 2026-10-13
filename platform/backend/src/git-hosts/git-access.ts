import {
  type GitHost,
  type GitProvider,
  gitHostFromUrl,
  isCloudGitHost,
} from "@archestra/shared";
import { RuntimeCredentialDefinitionModel } from "@/models";
import { resolveCredentialValue } from "@/services/credentials";
import { ApiError } from "@/types";
import { GitHostClient } from "./git-host-client";

/** A host and the token that reads it; no token means public access. */
export interface GitAccess {
  host: GitHost;
  token?: string;
}

/**
 * The host and token behind a stored credential: a GitHub App (its own host,
 * so GitHub Enterprise Server works), a GitLab access token (its own host),
 * or a legacy GitHub personal access token (github.com).
 */
export async function resolveGitCredentialAccess(params: {
  organizationId: string;
  credentialId: string;
}): Promise<GitAccess> {
  const definition = await RuntimeCredentialDefinitionModel.findById({
    id: params.credentialId,
    organizationId: params.organizationId,
  });
  if (!definition) throw new ApiError(404, "Git credential not found");
  const host =
    definition.kind === "gitlab_token"
      ? gitHostFromUrl({ provider: "gitlab", url: definition.gitlabUrl })
      : definition.kind === "github_app"
        ? gitHostFromUrl({ provider: "github", url: definition.githubUrl })
        : definition.kind === "secret"
          ? gitHostFromUrl({ provider: "github" })
          : null;
  if (!host) throw new ApiError(400, "This credential can't read repositories");
  const token = await resolveCredentialValue({
    organizationId: params.organizationId,
    credentialId: definition.key,
    scope: "organization",
  });
  if (!token) throw new ApiError(400, `${definition.name} has no stored value`);
  return { host, token };
}

/**
 * Access for a source row: its credential when it has one, otherwise public
 * access to the provider's cloud. Self-hosted repositories always need a
 * credential, so a server is only ever reached through one an admin saved.
 */
export async function resolveGitSourceAccess(params: {
  organizationId: string;
  provider: GitProvider;
  credentialId: string | null;
  /** Web address recorded on the source, null for the provider's cloud. */
  origin?: string | null;
}): Promise<GitAccess> {
  if (params.credentialId) {
    const access = await resolveGitCredentialAccess({
      organizationId: params.organizationId,
      credentialId: params.credentialId,
    });
    if (access.host.provider !== params.provider)
      throw new ApiError(
        400,
        "The source's credential belongs to a different Git provider",
      );
    if (params.origin && access.host.webUrl !== params.origin)
      throw new ApiError(
        400,
        `The source's credential is for ${access.host.webUrl}, not ${params.origin}`,
      );
    return access;
  }
  const host = gitHostFromUrl({
    provider: params.provider,
    url: params.origin,
  });
  if (!isCloudGitHost(host))
    throw new ApiError(
      400,
      `Reading from ${host.webUrl} needs a saved credential for it`,
    );
  return { host };
}

export function gitClient(access: GitAccess): GitHostClient {
  return new GitHostClient(access.host, access.token);
}
