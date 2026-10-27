import { createHash, randomBytes } from "node:crypto";
import { getGithubApiBaseUrl, getGithubWebOrigin } from "@archestra/shared";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import {
  fetchAsGithubApp,
  GITHUB_APP_NOT_FOUND,
  resolveInstallationToken,
} from "@/integrations/github/app-auth";
import logger from "@/logging";
import {
  OrganizationModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
  VerificationModel,
} from "@/models";
import { isByosEnabled } from "@/secrets-manager";
import {
  createRuntimeCredentialDefinition,
  deleteRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import {
  githubAppManifestSetup,
  isAppGone,
} from "@/services/github-app-manifest-setup";
import { resolveOpenAppaGitlabAccess } from "@/services/openappa-github-access";
import { openappaGitlab } from "@/services/openappa-gitlab";
import { ApiError } from "@/types";
import type { AppaGithubRepositoryStatus } from "@/types/openappa-github-app-setup";
import { decryptSecretValue, encryptSecretValue } from "@/utils/crypto";

/**
 * Registers the OpenAPPA GitHub App from a manifest so the operator never
 * copies an App ID, installation ID or private key by hand:
 *
 * 1. `start` returns the manifest the browser posts to GitHub.
 * 2. GitHub creates the App and returns a one-time code; `complete` trades it
 *    for the App's credentials and holds them, encrypted, until it is installed.
 * 3. `install` finds the installation on the organization and stores the App
 *    as an organization credential the sync can use.
 */
class OpenAppaGithubAppSetup {
  /** Start the shared manifest setup for the account that owns the policy repository. */
  start(params: Owner & { organization: string }) {
    return githubAppManifestSetup.start({ ...params, flow: "openappa" });
  }

  /** The App created earlier in this setup, while it still awaits installation. */
  pending(params: Owner) {
    return githubAppManifestSetup.pending({ ...params, flow: "openappa" });
  }

  /** Forgets the App created in this setup, so the next attempt starts over. */
  discard(params: Owner) {
    return githubAppManifestSetup.discard(params);
  }

  async install(params: Owner) {
    const found = await githubAppManifestSetup.installation({
      ...params,
      flow: "openappa",
    });
    if (found.status === "waiting") return found;
    const { app, installation } = found;
    const definition = await githubAppManifestSetup.saveCredential({
      ...params,
      app,
      installationId: String(installation.id),
      description: `Syncs the OpenAPPA policy with ${app.account} on GitHub.`,
      icon: "logo:openappa",
      value: JSON.stringify(app.secret),
    });
    await githubAppManifestSetup.discard(params);
    return {
      status: "installed" as const,
      id: definition.id,
      name: definition.name,
      account: app.account,
    };
  }

  /** The GitHub account each organization GitHub App is installed on. */
  async accounts(organizationId: string) {
    return Promise.all(
      (await this.githubApps(organizationId)).map(async (app) => {
        try {
          const installation = await fetchAsGithubApp<Installation>({
            githubUrl: app.api,
            appId: app.appId,
            privateKey: app.privateKey,
            path: `/app/installations/${encodeURIComponent(app.installationId)}`,
          });
          return { id: app.id, account: installation.account?.login ?? null };
        } catch {
          return { id: app.id, account: null };
        }
      }),
    );
  }

  /**
   * The repositories a GitHub App can reach, so setup offers a list instead of
   * asking for a name. Recent template copies come first: a fresh setup just
   * created one.
   */
  async repositories(params: { organizationId: string; credentialId: string }) {
    const gitlab = await gitlabAccess(params);
    if (gitlab) return openappaGitlab.repositories(gitlab);
    const app = (await this.githubApps(params.organizationId)).find(
      (entry) => entry.id === params.credentialId,
    );
    if (!app) throw new ApiError(404, "GitHub App not found");
    const [repositories, installation] = await Promise.all([
      listRepositories(app),
      fetchAsGithubApp<Installation>({
        githubUrl: app.api,
        appId: app.appId,
        privateKey: app.privateKey,
        path: `/app/installations/${encodeURIComponent(app.installationId)}`,
      }).catch(() => null),
    ]);
    // GitHub's page for changing which repositories the App can reach.
    return { repositories, manageUrl: installation?.html_url ?? null };
  }

  /**
   * Whether `repo` already exists, so setup can skip creating it. Archestra can
   * only see a private repository through a GitHub App installed on it, so a
   * repository no App can reach reads as unknown rather than missing.
   */
  async repository(params: {
    organizationId: string;
    credentialId: string;
    repo: string;
    ref?: string;
    path?: string;
    validationDirectory?: string;
  }): Promise<AppaGithubRepositoryStatus> {
    const { repo, ref } = params;
    const path = params.path ?? "appa.toml";
    const gitlab = await gitlabAccess(params);
    if (gitlab)
      return openappaGitlab.repositoryStatus({
        access: gitlab,
        repo,
        ref,
        path,
        validationDirectory: params.validationDirectory ?? VALIDATION_DIRECTORY,
      });
    const app = (await this.githubApps(params.organizationId)).find(
      (entry) => entry.id === params.credentialId,
    );
    if (!app) throw new ApiError(404, "GitHub App not found");
    const token = await resolveInstallationToken({
      githubUrl: app.api,
      ...app,
    }).catch(() => null);
    if (!token) return { status: "app_error", validations: null };
    const get = (url: string, method: "GET" | "HEAD" = "GET") =>
      fetch(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
    const response = await get(`${app.api}/repos/${repo}`);
    if (!response?.ok) return { status: "unreachable", validations: null };
    const found = RepositorySchema.safeParse(await response.json());
    if (!found.success) return { status: "unreachable", validations: null };
    // An empty repository gets the template's files written into it; GitHub
    // answers 409 for the commits of a repository without any.
    const commits = await get(`${app.api}/repos/${repo}/commits?per_page=1`);
    if (commits?.status === 409) return { status: "empty", validations: null };
    const directory = params.validationDirectory ?? VALIDATION_DIRECTORY;
    if (
      !ref &&
      path === "appa.toml" &&
      directory === VALIDATION_DIRECTORY &&
      found.data.private &&
      found.data.template_repository?.full_name.toLowerCase() === TEMPLATE_REPO
    )
      return { status: "template", validations: null };
    const contents = (entry: string) =>
      get(
        `${app.api}/repos/${repo}/contents/${entry.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
        "HEAD",
      );
    const [policy, validations] = await Promise.all([
      contents(path),
      contents(directory),
    ]);
    return {
      status: policy?.ok ? "policy" : "other",
      validations: !!validations?.ok,
    };
  }

  private async githubApps(organizationId: string) {
    const apps = await Promise.all(
      (await RuntimeCredentialDefinitionModel.list(organizationId)).map(
        async (definition) => {
          if (
            definition.kind !== "github_app" ||
            !definition.allowOrganization ||
            !definition.appId ||
            !definition.installationId
          )
            return null;
          const privateKey =
            await RuntimeCredentialConnectionModel.resolveValue({
              organizationId,
              credentialId: definition.key,
              scope: "organization",
            }).catch(() => null);
          return privateKey
            ? {
                id: definition.id,
                api: (definition.githubUrl ?? GITHUB_API_URL).replace(
                  /\/+$/,
                  "",
                ),
                appId: definition.appId,
                installationId: definition.installationId,
                privateKey,
              }
            : null;
        },
      ),
    );
    return apps.filter((app) => app !== null);
  }
}

export const openappaGithubAppSetup = new OpenAppaGithubAppSetup();

/** Access through a GitLab token, or null when the credential is something else. */
async function gitlabAccess(params: {
  organizationId: string;
  credentialId: string;
}) {
  const definition = await RuntimeCredentialDefinitionModel.findById({
    id: params.credentialId,
    organizationId: params.organizationId,
  });
  if (definition?.kind !== "gitlab_token") return null;
  return resolveOpenAppaGitlabAccess({
    organizationId: params.organizationId,
    gitlabTokenId: definition.id,
  });
}

// ===================== Internals =====================

githubAppManifestSetup.register("openappa", {
  allowPersonal: true,
  organizationRequired: "",
  authorize: assertAllowed,
  manifest: ({ appName, api }) =>
    // Off github.com there is no template; setup writes the workflow itself.
    manifest({ appName, seedsWorkflow: api !== GITHUB_API_URL }),
});

async function assertAllowed(owner: Owner) {
  if (!enterpriseTier.isOpenappaActive())
    throw new ApiError(
      409,
      "Enable OpenAPPA on the server before configuring Git sync",
    );
  if (isByosEnabled())
    throw new ApiError(
      400,
      "Creating a GitHub App requires writable secret storage. Add an existing App instead.",
    );
  if (
    !(await userHasPermission(
      owner.userId,
      owner.organizationId,
      "credential",
      "create",
    ))
  )
    throw new ApiError(403, "You do not have access to create credentials");
}

type Owner = { organizationId: string; userId: string };

const GITHUB_API_URL = "https://api.github.com";
type Installation = {
  id: number;
  html_url?: string;
  account: { login: string; id: number } | null;
  repository_selection: "all" | "selected";
};

function manifest(params: { appName: string; seedsWorkflow: boolean }) {
  const { appName } = params;
  const callbackUrl = `${config.frontendBaseUrl}/github/app-setup`;
  return {
    // App names are unique across GitHub; the create page lets the admin rename it.
    name: "OpenAPPA Sync",
    // The deployment's own name, so white-labeled deployments don't show Archestra on GitHub.
    description: `Keeps the ${appName} OpenAPPA guardrails policy in sync with one GitHub repository. ${appName} reads the policy from it and opens pull requests for policy changes made in ${appName}.`,
    url: config.frontendBaseUrl,
    redirect_url: callbackUrl,
    setup_url: callbackUrl,
    public: false,
    // Contents and pull requests on the policy repository; it never creates repositories.
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      ...(params.seedsWorkflow ? { workflows: "write" } : {}),
    },
    default_events: [],
    // No webhook: sync polls GitHub, and GitHub rejects hook URLs it cannot reach.
  };
}

async function listRepositories(params: {
  api: string;
  appId: string;
  installationId: string;
  privateKey: string;
}) {
  const token = await resolveInstallationToken({
    githubUrl: params.api,
    ...params,
  });
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const repositories: InstallationRepository[] = [];
  for (let page = 1; page <= REPOSITORY_PAGES; page++) {
    const response = await fetch(
      `${params.api}/installation/repositories?per_page=100&page=${page}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok)
      throw new ApiError(
        502,
        `GitHub returned HTTP ${response.status} while listing the App's repositories.`,
      );
    const listed = InstallationRepositoriesSchema.parse(await response.json());
    repositories.push(...listed.repositories);
    if (listed.repositories.length < 100) break;
  }
  repositories.sort((a, b) => b.created_at.localeCompare(a.created_at));
  // Listing omits the template; look it up for the newest private ones only.
  const templates = new Set(
    (
      await Promise.all(
        repositories
          .filter((entry) => entry.private)
          .slice(0, 10)
          .map(async (entry) => {
            const found = await fetch(
              `${params.api}/repos/${entry.full_name}`,
              {
                headers,
                redirect: "error",
                signal: AbortSignal.timeout(15_000),
              },
            ).catch(() => null);
            if (!found?.ok) return null;
            const detail = RepositorySchema.safeParse(await found.json());
            return detail.success &&
              detail.data.template_repository?.full_name.toLowerCase() ===
                TEMPLATE_REPO
              ? entry.full_name
              : null;
          }),
      )
    ).filter((name) => name !== null),
  );
  return repositories
    .map((entry) => ({
      fullName: entry.full_name,
      private: entry.private,
      description: entry.description ?? null,
      template: templates.has(entry.full_name),
    }))
    .sort((a, b) => Number(b.template) - Number(a.template));
}

const REPOSITORY_PAGES = 5;

const InstallationRepositorySchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  description: z.string().nullable().optional(),
  created_at: z.string(),
});
type InstallationRepository = z.infer<typeof InstallationRepositorySchema>;
const InstallationRepositoriesSchema = z.object({
  repositories: z.array(InstallationRepositorySchema),
});

const TEMPLATE_REPO = "archestra-ai/openappa-config";
/** Where the template keeps validations. */
const VALIDATION_DIRECTORY = "traces";
const RepositorySchema = z.object({
  private: z.boolean(),
  template_repository: z.object({ full_name: z.string() }).nullish(),
});

const AccountSchema = z.object({
  login: z.string(),
  type: z.enum(["User", "Organization"]),
});
