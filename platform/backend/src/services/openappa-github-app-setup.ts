import { createHash, randomBytes } from "node:crypto";
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
  async start(params: Owner & { owner: string }) {
    await this.assertAllowed(params);
    const account = await lookupAccount(params.owner);
    const state = randomBytes(32).toString("base64url");
    const identifier = flowIdentifier(params, "start");
    await VerificationModel.deleteByIdentifier(identifier);
    await VerificationModel.create({
      identifier,
      expiresAt: new Date(Date.now() + START_TTL_MS),
      value: JSON.stringify({
        stateHash: hash(state),
        owner: account.login,
      }),
    });
    // A personal App can only be registered by that user, while signed in.
    const url = new URL(
      account.type === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/apps/new`
        : "https://github.com/settings/apps/new",
    );
    url.searchParams.set("state", state);
    return {
      url: url.toString(),
      manifest: JSON.stringify(manifest()),
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
      `https://api.github.com/app-manifests/${encodeURIComponent(params.code)}/conversions`,
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

  async install(params: Owner & { repo: string }) {
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
    // The App only needs the policy repository; anything broader is the admin's choice.
    if (
      !(await canAccessRepo({
        appId: pending.appId,
        installationId: String(installation.id),
        privateKey: secret.privateKey,
        repo: params.repo,
      }))
    )
      throw new ApiError(
        400,
        `Give ${pending.name} access to ${params.repo} on GitHub.`,
      );

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
        githubUrl: GITHUB_API_URL,
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

  /** Where each organization GitHub App is installed, so setup can suggest the repository owner. */
  async accounts(organizationId: string, repo?: string) {
    const definitions = (
      await RuntimeCredentialDefinitionModel.list(organizationId)
    ).filter(
      (definition) =>
        definition.kind === "github_app" &&
        definition.allowOrganization &&
        definition.githubUrl === GITHUB_API_URL &&
        definition.appId &&
        definition.installationId,
    );
    return Promise.all(
      definitions.map(async (definition) => {
        try {
          const privateKey =
            await RuntimeCredentialConnectionModel.resolveValue({
              organizationId,
              credentialId: definition.key,
              scope: "organization",
            });
          if (!privateKey)
            return { id: definition.id, account: null, canAccessRepo: null };
          const installation = await fetchAsGithubApp<Installation>({
            githubUrl: GITHUB_API_URL,
            appId: definition.appId as string,
            privateKey,
            path: `/app/installations/${encodeURIComponent(definition.installationId as string)}`,
          });
          return {
            id: definition.id,
            account: installation.account?.login ?? null,
            canAccessRepo: repo
              ? await canAccessRepo({
                  appId: definition.appId as string,
                  installationId: definition.installationId as string,
                  privateKey,
                  repo,
                })
              : null,
          };
        } catch {
          return { id: definition.id, account: null, canAccessRepo: null };
        }
      }),
    );
  }

  /**
   * Whether `repo` already exists, so setup can skip creating it. Archestra can
   * only see a private repository through a GitHub App installed on it, so a
   * repository no App can reach reads as unknown rather than missing.
   */
  async repository(params: {
    organizationId: string;
    repo: string;
    ref?: string;
    path?: string;
  }): Promise<AppaGithubRepositoryStatus> {
    const { organizationId, repo } = params;
    const path = params.path ?? "appa.toml";
    const tokens: (string | null)[] = [null];
    for (const definition of await RuntimeCredentialDefinitionModel.list(
      organizationId,
    )) {
      if (
        definition.kind !== "github_app" ||
        !definition.allowOrganization ||
        definition.githubUrl !== GITHUB_API_URL ||
        !definition.appId ||
        !definition.installationId
      )
        continue;
      const privateKey = await RuntimeCredentialConnectionModel.resolveValue({
        organizationId,
        credentialId: definition.key,
        scope: "organization",
      }).catch(() => null);
      if (!privateKey) continue;
      tokens.push(
        await resolveInstallationToken({
          githubUrl: GITHUB_API_URL,
          appId: definition.appId,
          installationId: definition.installationId,
          privateKey,
        }).catch(() => null),
      );
    }
    for (const [index, token] of tokens.entries()) {
      if (index > 0 && !token) continue;
      const response = await fetch(`${GITHUB_API_URL}/repos/${repo}`, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!response) continue;
      if (!response.ok) continue;
      const found = RepositorySchema.safeParse(await response.json());
      if (!found.success) continue;
      if (
        !params.ref &&
        path === "appa.toml" &&
        found.data.private &&
        found.data.template_repository?.full_name.toLowerCase() ===
          TEMPLATE_REPO
      )
        return { status: "template" };
      const policy = await fetch(
        `${GITHUB_API_URL}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${params.ref ? `?ref=${encodeURIComponent(params.ref)}` : ""}`,
        {
          method: "HEAD",
          headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      ).catch(() => null);
      return { status: policy?.ok ? "policy" : "other" };
    }
    return { status: "unknown" };
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
      githubUrl: GITHUB_API_URL,
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
  secret: z.object({ __encrypted: z.string() }),
});
type StoredPendingApp = z.infer<typeof StoredPendingAppSchema>;
type Installation = {
  id: number;
  account: { login: string; id: number } | null;
  repository_selection: "all" | "selected";
};

function manifest() {
  const callbackUrl = `${config.frontendBaseUrl}/github/app-setup`;
  return {
    // App names are unique across GitHub; the create page lets the admin rename it.
    name: "OpenAPPA Sync",
    description:
      "Keeps an Archestra deployment's OpenAPPA guardrails policy in sync with a GitHub repository. Archestra reads the policy from the repository, opens pull requests for policy changes made in Archestra, and creates the policy repository during setup.",
    url: config.frontendBaseUrl,
    redirect_url: callbackUrl,
    setup_url: callbackUrl,
    public: false,
    // Contents and pull requests on the policy repository; it never creates repositories.
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
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
    htmlUrl: pending.htmlUrl,
    installUrl: `https://github.com/apps/${encodeURIComponent(pending.slug)}/installations/new/permissions?target_id=${pending.accountId}`,
    settingsUrl:
      pending.accountType === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(pending.account)}/settings/apps/${encodeURIComponent(pending.slug)}`
        : `https://github.com/settings/apps/${encodeURIComponent(pending.slug)}`,
  };
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

/** The GitHub account that will own the App, from GitHub's public profile. */
async function lookupAccount(login: string) {
  const response = await fetch(
    `${GITHUB_API_URL}/users/${encodeURIComponent(login)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404)
    throw new ApiError(400, `GitHub has no account named ${login}.`);
  const account = response.ok
    ? AccountSchema.safeParse(await response.json())
    : null;
  if (!account?.success)
    throw new ApiError(502, `GitHub didn't return the ${login} account.`);
  return account.data;
}

async function canAccessRepo(params: {
  appId: string;
  installationId: string;
  privateKey: string;
  repo: string;
}) {
  const token = await resolveInstallationToken({
    githubUrl: GITHUB_API_URL,
    appId: params.appId,
    installationId: params.installationId,
    privateKey: params.privateKey,
  });
  const response = await fetch(`${GITHUB_API_URL}/repos/${params.repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new ApiError(
    502,
    `GitHub returned HTTP ${response.status} while checking access to ${params.repo}.`,
  );
}

const TEMPLATE_REPO = "archestra-ai/openappa-config";
const RepositorySchema = z.object({
  private: z.boolean(),
  template_repository: z.object({ full_name: z.string() }).nullish(),
});

const AccountSchema = z.object({
  login: z.string(),
  type: z.enum(["User", "Organization"]),
});
