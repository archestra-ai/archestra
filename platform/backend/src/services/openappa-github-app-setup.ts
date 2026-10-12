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
import { ApiError } from "@/types";
import type {
  AppaGithubRepositoryStatus,
  PendingAppaGithubApp,
} from "@/types/openappa-github-app-setup";
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
  async start(params: Owner & { githubUrl: string; owner: string }) {
    await this.assertAllowed(params);
    const { web, api } = parseGithubUrl(params.githubUrl);
    const account = await lookupAccount({ api, login: params.owner });
    const state = randomBytes(32).toString("base64url");
    const identifier = flowIdentifier(params, "start");
    await VerificationModel.deleteByIdentifier(identifier);
    await VerificationModel.create({
      identifier,
      expiresAt: new Date(Date.now() + START_TTL_MS),
      value: JSON.stringify({
        stateHash: hash(state),
        owner: account.login,
        web,
        api,
      }),
    });
    // A personal App can only be registered by that user, while signed in.
    const url = new URL(
      account.type === "Organization"
        ? `${web}/organizations/${encodeURIComponent(account.login)}/settings/apps/new`
        : `${web}/settings/apps/new`,
    );
    url.searchParams.set("state", state);
    return {
      url: url.toString(),
      manifest: JSON.stringify(
        manifest({
          appName: await OrganizationModel.getAppName(),
          // Off github.com there is no template; setup writes the workflow itself.
          seedsWorkflow: api !== GITHUB_API_URL,
        }),
      ),
    };
  }

  async complete(params: Owner & { code: string; state: string }) {
    await this.assertAllowed(params);
    const record = await VerificationModel.consume(
      flowIdentifier(params, "start"),
    );
    const flow = record
      ? StartFlowSchema.safeParse(JSON.parse(record.value))
      : null;
    if (!flow?.success || flow.data.stateHash !== hash(params.state))
      throw new ApiError(
        400,
        "GitHub App setup expired or was started elsewhere. Start again.",
      );
    const response = await fetch(
      `${flow.data.api}/app-manifests/${encodeURIComponent(params.code)}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const app = response.ok
      ? ConversionSchema.safeParse(await response.json())
      : null;
    if (!app?.success) {
      logger.warn(
        { status: response.status },
        "GitHub App manifest conversion failed",
      );
      throw new ApiError(
        502,
        "GitHub didn't return the new App. Start again; codes expire after an hour.",
      );
    }
    if (app.data.owner.login.toLowerCase() !== flow.data.owner.toLowerCase())
      throw new ApiError(
        400,
        `The App was created for ${app.data.owner.login}, not ${flow.data.owner}. Sign in to GitHub as ${flow.data.owner} and start again.`,
      );
    const pending: StoredPendingApp = {
      appId: String(app.data.id),
      name: app.data.name,
      slug: app.data.slug,
      clientId: app.data.client_id,
      account: app.data.owner.login,
      accountId: app.data.owner.id,
      accountType: app.data.owner.type === "User" ? "User" : "Organization",
      htmlUrl: app.data.html_url,
      web: flow.data.web,
      api: flow.data.api,
      secret: encryptSecretValue({
        privateKey: app.data.pem,
        clientSecret: app.data.client_secret,
      }),
    };
    const identifier = flowIdentifier(params, "pending");
    await VerificationModel.deleteByIdentifier(identifier);
    await VerificationModel.create({
      identifier,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      value: JSON.stringify(pending),
    });
    return toPublic(pending);
  }

  /** The App created earlier in this setup, while it still awaits installation. */
  async pending(params: Owner): Promise<PendingAppaGithubApp | null> {
    const pending = await this.loadPending(params);
    if (!pending) return null;
    // Someone may have deleted the App on GitHub before installing it.
    try {
      await this.fetchAsPending(pending, "/app");
    } catch (error) {
      if (isAppGone(error)) {
        await this.discard(params);
        return null;
      }
    }
    return toPublic(pending);
  }

  /** Forgets the App created in this setup, so the next attempt starts over. */
  async discard(params: Owner) {
    await VerificationModel.deleteByIdentifier(
      flowIdentifier(params, "pending"),
    );
  }

  async install(params: Owner) {
    await this.assertAllowed(params);
    const pending = await this.loadPending(params);
    if (!pending)
      throw new ApiError(
        400,
        "GitHub App setup expired. Create the App again.",
      );
    const secret = SecretSchema.parse(decryptSecretValue(pending.secret));
    let installations: Installation[];
    try {
      installations = await this.fetchAsPending<Installation[]>(
        pending,
        "/app/installations",
      );
    } catch (error) {
      if (!isAppGone(error)) throw error;
      await this.discard(params);
      throw new ApiError(
        410,
        `${pending.name} no longer exists on GitHub. Create the App again.`,
      );
    }
    const installation = installations.find(
      (entry) => entry.account?.id === pending.accountId,
    );
    if (!installation) return { status: "waiting" as const };
    const definition = await createRuntimeCredentialDefinition({
      organizationId: params.organizationId,
      userId: params.userId,
      definition: {
        key: await this.freeKey(params.organizationId, pending.slug),
        kind: "github_app",
        name: pending.name,
        description: `Syncs the OpenAPPA policy with ${pending.account} on GitHub.`,
        icon: "logo:openappa",
        allowPersonal: false,
        allowOrganization: true,
        githubUrl: pending.api,
        appId: pending.appId,
        installationId: String(installation.id),
        githubClientId: pending.clientId,
      },
    });
    try {
      await setRuntimeCredentialConnection({
        organizationId: params.organizationId,
        userId: params.userId,
        credentialId: definition.key,
        scope: "organization",
        value: JSON.stringify(secret),
      });
    } catch (error) {
      // Without its key the credential cannot sign in; don't leave it behind.
      await deleteRuntimeCredentialDefinition({
        organizationId: params.organizationId,
        key: definition.key,
      }).catch(() => undefined);
      throw error;
    }
    await VerificationModel.deleteByIdentifier(
      flowIdentifier(params, "pending"),
    );
    return {
      status: "installed" as const,
      id: definition.id,
      name: definition.name,
      account: pending.account,
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

  private async assertAllowed(owner: Owner) {
    if (!enterpriseTier.isOpenappaActive())
      throw new ApiError(
        409,
        "Enable OpenAPPA on the server before configuring GitHub sync",
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

  private fetchAsPending<T>(pending: StoredPendingApp, path: `/app${string}`) {
    const secret = SecretSchema.parse(decryptSecretValue(pending.secret));
    return fetchAsGithubApp<T>({
      githubUrl: pending.api,
      appId: pending.appId,
      privateKey: secret.privateKey,
      path,
    });
  }

  private async loadPending(owner: Owner) {
    const record = await VerificationModel.getByIdentifier(
      flowIdentifier(owner, "pending"),
    );
    if (!record || record.expiresAt <= new Date()) return null;
    const parsed = StoredPendingAppSchema.safeParse(JSON.parse(record.value));
    return parsed.success ? parsed.data : null;
  }

  private async freeKey(organizationId: string, slug: string) {
    const base = `github-app-${slug}`.slice(0, 120);
    for (let suffix = 0; suffix < 100; suffix++) {
      const key = suffix ? `${base}-${suffix + 1}` : base;
      if (
        !(await RuntimeCredentialDefinitionModel.find({ organizationId, key }))
      )
        return key;
    }
    throw new ApiError(409, "Too many credentials share this App's name");
  }
}

export const openappaGithubAppSetup = new OpenAppaGithubAppSetup();

// ===================== Internals =====================

type Owner = { organizationId: string; userId: string };

const GITHUB_API_URL = "https://api.github.com";
const START_TTL_MS = 30 * 60_000;
// GitHub's manifest code lives an hour; installing usually follows within minutes.
const PENDING_TTL_MS = 60 * 60_000;

const StartFlowSchema = z.object({
  stateHash: z.string(),
  owner: z.string(),
  web: z.string(),
  api: z.string(),
});
const ConversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  pem: z.string().min(1),
  html_url: z.string().url(),
  owner: z.object({
    login: z.string(),
    id: z.number().int(),
    type: z.string(),
  }),
});
const SecretSchema = z.object({
  privateKey: z.string().min(1),
  clientSecret: z.string().min(1),
});
const StoredPendingAppSchema = z.object({
  appId: z.string(),
  name: z.string(),
  slug: z.string(),
  clientId: z.string(),
  account: z.string(),
  accountId: z.number().int(),
  accountType: z.enum(["User", "Organization"]),
  htmlUrl: z.string(),
  web: z.string(),
  api: z.string(),
  secret: z.object({ __encrypted: z.string() }),
});
type StoredPendingApp = z.infer<typeof StoredPendingAppSchema>;
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

function toPublic(pending: StoredPendingApp): PendingAppaGithubApp {
  return {
    name: pending.name,
    slug: pending.slug,
    account: pending.account,
    appId: pending.appId,
    accountUrl: `${pending.web}/${pending.account}`,
    htmlUrl: pending.htmlUrl,
    // GitHub's own App page: /apps/<slug> on github.com, /github-apps/<slug> on Enterprise Server.
    installUrl: installUrl(pending),
    settingsUrl:
      pending.accountType === "Organization"
        ? `${pending.web}/organizations/${encodeURIComponent(pending.account)}/settings/apps/${encodeURIComponent(pending.slug)}`
        : `${pending.web}/settings/apps/${encodeURIComponent(pending.slug)}`,
  };
}

/**
 * Opens the install page on the owning account. GitHub can pre-tick
 * repositories only by numeric ID (`suggested_target_id` + `repository_ids[]`),
 * and a private repository's ID stays hidden until the App is installed, so
 * the admin picks "Only select repositories" there.
 */
function installUrl(pending: StoredPendingApp) {
  const url = new URL(
    `${pending.htmlUrl.replace(/\/+$/, "")}/installations/new/permissions`,
  );
  url.searchParams.set("target_id", String(pending.accountId));
  return url.toString();
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function flowIdentifier(owner: Owner, step: "start" | "pending") {
  return `openappa-github-app:${step}:${JSON.stringify([owner.organizationId, owner.userId])}`;
}

function isAppGone(error: unknown) {
  return (
    error instanceof ApiError && error.internalCode === GITHUB_APP_NOT_FOUND
  );
}

/** A GitHub address becomes its web and API bases; any path is ignored. */
function parseGithubUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(
      400,
      "Use your GitHub's address, such as https://github.com.",
    );
  }
  if (!["https:", "http:"].includes(url.protocol))
    throw new ApiError(
      400,
      "Use your GitHub's address, such as https://github.com.",
    );
  const api = getGithubApiBaseUrl(url.origin);
  return { web: getGithubWebOrigin(api), api };
}

/** The GitHub account that will own the App, from GitHub's public profile. */
async function lookupAccount(params: { api: string; login: string }) {
  const { login } = params;
  const response = await fetch(
    `${params.api}/users/${encodeURIComponent(login)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  // Private Enterprise Server instances need a sign-in to read profiles.
  if (response.status === 401 || response.status === 403)
    return { login, type: "Organization" as const };
  if (response.status === 404)
    throw new ApiError(400, `GitHub has no account named ${login}.`);
  const account = response.ok
    ? AccountSchema.safeParse(await response.json())
    : null;
  if (!account?.success)
    throw new ApiError(502, `GitHub didn't return the ${login} account.`);
  return account.data;
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
