import { gitHostFromUrl } from "@archestra/shared";
import { GitHostClient, GitHostError } from "@/git-hosts/git-host-client";
import { createSharedCredential } from "@/models/_shared/credential-store";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { secretManager } from "@/secrets-manager";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  type CreateGitlabTokenRequest,
  type GitCredential,
} from "@/types";

/** GitHub Apps and GitLab tokens the organization can read repositories with. */
export async function listGitCredentials(
  organizationId: string,
): Promise<GitCredential[]> {
  const definitions =
    await RuntimeCredentialDefinitionModel.list(organizationId);
  return definitions.flatMap((definition): GitCredential[] => {
    if (!definition.allowOrganization) return [];
    if (definition.kind === "github_app")
      return [
        {
          id: definition.id,
          name: definition.name,
          provider: "github",
          kind: "github_app",
          webUrl: gitHostFromUrl({
            provider: "github",
            url: definition.githubUrl,
          }).webUrl,
          createdAt: definition.createdAt,
        },
      ];
    if (definition.kind === "gitlab_token")
      return [
        {
          id: definition.id,
          name: definition.name,
          provider: "gitlab",
          kind: "gitlab_token",
          webUrl: gitHostFromUrl({
            provider: "gitlab",
            url: definition.gitlabUrl,
          }).webUrl,
          createdAt: definition.createdAt,
        },
      ];
    return [];
  });
}

/**
 * Save a GitLab access token after GitLab confirms it works and can read the
 * API. Project, group, and personal access tokens all qualify.
 */
export async function createGitlabToken(params: {
  organizationId: string;
  /** Becomes the credential's author, who is granted full access to it. */
  userId?: string;
  data: CreateGitlabTokenRequest;
}): Promise<GitCredential> {
  let host: ReturnType<typeof gitHostFromUrl>;
  try {
    host = gitHostFromUrl({ provider: "gitlab", url: params.data.gitlabUrl });
  } catch {
    throw new ApiError(400, "Enter a GitLab address, e.g. https://gitlab.com");
  }
  const client = new GitHostClient(host, params.data.token);
  try {
    const token = await client.json<{
      scopes?: string[];
      active?: boolean;
      revoked?: boolean;
    }>(`${host.apiUrl}/personal_access_tokens/self`);
    const scopes = token.scopes ?? [];
    if (!scopes.includes("api") && !scopes.includes("read_api"))
      throw new ApiError(
        400,
        "The token needs the api scope (or read_api to only read)",
      );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      error instanceof GitHostError && error.status === 401
        ? `${host.webUrl} rejected the token`
        : `Could not check the token with ${host.webUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const secret = await secretManager().createSecret(
    { apiToken: params.data.token },
    `gitlab-token-${params.data.name}`,
  );
  const definition = await createSharedCredential({
    organizationId: params.organizationId,
    name: params.data.name,
    kind: "gitlab_token",
    gitlabUrl: host.webUrl,
    secretId: secret.id,
    createdBy: params.userId ?? null,
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    initialPermissionGrants: await ResourcePermissions.defaultCredentialGrants({
      organizationId: params.organizationId,
      userId: params.userId,
    }),
    // SPDX-SnippetEnd
  });
  return {
    id: definition.id,
    name: definition.name,
    provider: "gitlab",
    kind: "gitlab_token",
    webUrl: host.webUrl,
    createdAt: definition.createdAt,
  };
}
