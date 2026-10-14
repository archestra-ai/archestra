import config from "@/config";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { parsePolicyToml } from "@/openappa/policy-text";
import {
  createRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";

export const GITHUB_ROSTER_ROOT = `include = ["batteries/github/appa.toml"]

[server_aliases]
github = ["github_prod"]

[policy]
version = 2
`;

type GithubFixtures = {
  organizationId: string;
  userId: string;
  makeInternalMcpCatalog: (overrides: {
    organizationId: string;
    name: string;
  }) => Promise<{ id: string }>;
  makeTool: (overrides: {
    catalogId: string;
    name: string;
    rawName: string;
  }) => Promise<unknown>;
};

/**
 * GitHub deployed as its multi-user target on a `github_prod` server, its
 * token bound to the organization's GitHub.com App `repository-app`, through
 * which members connect as `github-user`.
 */
export async function deployGithubWithRoster(params: GithubFixtures) {
  const { organizationId, userId } = params;
  await createGithubApp({
    organizationId,
    userId,
    key: "repository-app",
    githubUrl: "https://api.github.com",
  });
  await createRuntimeCredentialDefinition({
    organizationId,
    userId,
    definition: {
      description: "",
      icon: null,
      key: "github-user",
      name: "GitHub",
      kind: "github_app_user",
      allowPersonal: true,
      allowOrganization: false,
      githubAppCredentialKey: "repository-app",
    },
  });
  await declareGithub(params);
}

/** GitHub declared on a `github_prod` server with its token bound to `repository-app`. */
export async function declareGithub(params: GithubFixtures) {
  const { organizationId, userId } = params;
  config.openappa.enabled = true;
  config.daggerRuntime.enabled = true;
  const catalog = await params.makeInternalMcpCatalog({
    organizationId,
    name: "GitHub prod",
  });
  await params.makeTool({
    catalogId: catalog.id,
    name: "github_prod__get_issue",
    rawName: "get_issue",
  });
  const latest = await guardrailsPolicyService.get(organizationId);
  await guardrailsPolicyService.update({
    organizationId,
    userId,
    content: GITHUB_ROSTER_ROOT,
    expectedRevision: latest.revision,
  });
  await openappaBatteriesService.setCredentialBinding({
    userId,
    organizationId,
    variable: "APPA_PROVIDER_GITHUB_TOKEN",
    key: "repository-app",
  });
}

/** A GitHub App definition with an organization value. */
export async function createGithubApp(params: {
  organizationId: string;
  userId: string;
  key: string;
  githubUrl: string;
}) {
  const { organizationId, userId, key, githubUrl } = params;
  await createRuntimeCredentialDefinition({
    organizationId,
    userId,
    definition: {
      description: "",
      icon: null,
      key,
      name: key,
      kind: "github_app",
      allowPersonal: false,
      allowOrganization: true,
      githubUrl,
      appId: "123",
      installationId: "456",
      githubClientId: "test-client",
    },
  });
  await setRuntimeCredentialConnection({
    organizationId,
    userId,
    credentialId: key,
    scope: "organization",
    value: JSON.stringify({
      privateKey: "test-private-key",
      clientSecret: "test-client-secret",
    }),
  });
}

/** The readers of the host's member roster in the stored effective policy. */
export async function storedHostMembers(
  organizationId: string,
): Promise<unknown> {
  const stored = await OpenAppaEffectivePolicyModel.find(organizationId);
  const externals = parsePolicyToml(stored?.content ?? "")?.externals as
    | { audience?: Record<string, { readers?: unknown }> }
    | undefined;
  return externals?.audience?.["host-members"]?.readers;
}
