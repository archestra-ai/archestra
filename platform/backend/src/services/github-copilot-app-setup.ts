import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getGithubApiBaseUrl,
  getGithubWebOrigin,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import {
  fetchAsGithubApp,
  GITHUB_APP_NOT_FOUND,
} from "@/integrations/github/app-auth";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  OrganizationModel,
  VerificationModel,
} from "@/models";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import {
  decodeGithubAppCredential,
  encodeGithubAppCredential,
  type GithubAppCredential,
  githubAppApiBase,
  githubAppKeyFingerprint,
  githubAppOrganization,
  validateGithubAppPrivateKey,
} from "@/services/github-app-copilot-token";
import { modelSyncService } from "@/services/model-sync";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import type { PendingCopilotGithubApp } from "@/types/github-copilot-app-setup";
import { decryptSecretValue, encryptSecretValue } from "@/utils/crypto";
import { createGithubCopilotFetch } from "./github-copilot-token";

/**
 * Connects GitHub Copilot paid by a GitHub organization: registers a GitHub
 * App from a manifest (or takes an existing one), installs it on the
 * organization, and stores it as a shared `github-copilot` provider key.
 *
 * 1. `start` returns the manifest the browser posts to GitHub.
 * 2. GitHub creates the App and returns a one-time code; `complete` trades it
 *    for the App's credentials and holds them, encrypted, until installed.
 * 3. `install` finds the installation on the organization, checks Copilot
 *    answers, and creates the key.
 */
class CopilotGithubAppSetup {
  async start(params: Owner & { githubUrl: string; organization: string }) {
    const { web, api } = parseGithubUrl(params.githubUrl);
    const account = await lookupAccount({ api, login: params.organization });
    if (account.type !== "Organization")
      throw new ApiError(400, NOT_AN_ORGANIZATION);
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
    const url = new URL(
      `${web}/organizations/${encodeURIComponent(account.login)}/settings/apps/new`,
    );
    url.searchParams.set("state", state);
    return {
      url: url.toString(),
      manifest: JSON.stringify(
        manifest({ appName: await OrganizationModel.getAppName() }),
      ),
    };
  }

  async complete(params: Owner & { code: string; state: string }) {
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
        "Copilot GitHub App manifest conversion failed",
      );
      throw new ApiError(
        502,
        "GitHub didn't return the new App. Start again; codes expire after an hour.",
      );
    }
    if (app.data.owner.type !== "Organization")
      throw new ApiError(400, NOT_AN_ORGANIZATION);
    if (app.data.owner.login.toLowerCase() !== flow.data.owner.toLowerCase())
      throw new ApiError(
        400,
        `The App was created for ${app.data.owner.login}, not ${flow.data.owner}. Start again from ${flow.data.owner}.`,
      );
    const pending: StoredPendingApp = {
      appId: String(app.data.id),
      name: app.data.name,
      slug: app.data.slug,
      account: app.data.owner.login,
      accountId: app.data.owner.id,
      htmlUrl: app.data.html_url,
      web: flow.data.web,
      api: flow.data.api,
      secret: encryptSecretValue({ privateKey: app.data.pem }),
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
  async pending(params: Owner): Promise<PendingCopilotGithubApp | null> {
    const pending = await this.loadPending(params);
    if (!pending) return null;
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

  async install(params: Owner & { grants?: ResourcePermissionGrant[] }) {
    const pending = await this.loadPending(params);
    if (!pending)
      throw new ApiError(
        400,
        "GitHub App setup expired. Create the App again.",
      );
    const { privateKey } = SecretSchema.parse(
      decryptSecretValue(pending.secret),
    );
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
    const result = await this.connect({
      ...params,
      credential: {
        appId: pending.appId,
        installationId: String(installation.id),
        privateKey,
        githubUrl: pending.web,
        organization: pending.account,
      },
      installation,
    });
    await this.discard(params);
    return result;
  }

  /** Check an existing App: its key, and its installation on the organization. */
  async validateExisting(params: {
    githubUrl: string;
    appId: string;
    organization: string;
    privateKey: string;
  }) {
    const { appId, privateKey, fingerprint } =
      validateGithubAppPrivateKey(params);
    const { web, api } = parseGithubUrl(params.githubUrl);
    let installations: Installation[];
    try {
      installations = await fetchAsGithubApp<Installation[]>({
        githubUrl: api,
        appId,
        privateKey,
        path: "/app/installations",
      });
    } catch (error) {
      if (isAppGone(error))
        throw new ApiError(
          400,
          `GitHub doesn't recognize App ${appId} with this private key. Check the App ID and download a current private key from the App settings.`,
        );
      throw error;
    }
    const installation = installations.find(
      (entry) =>
        entry.account?.login.toLowerCase() ===
        params.organization.toLowerCase(),
    );
    if (!installation?.account)
      throw new ApiError(
        400,
        `The App isn't installed on ${params.organization}. Install it on the organization on GitHub, then try again.`,
      );
    return {
      fingerprint,
      installationId: String(installation.id),
      organization: installation.account.login,
      credential: {
        appId,
        installationId: String(installation.id),
        privateKey,
        githubUrl: web,
        organization: installation.account.login,
      } satisfies GithubAppCredential,
      installation,
    };
  }

  async connectExisting(
    params: Owner & {
      githubUrl: string;
      appId: string;
      organization: string;
      privateKey: string;
      grants?: ResourcePermissionGrant[];
      replaceKeyId?: string;
    },
  ) {
    const { credential, installation } = await this.validateExisting(params);
    return this.connect({ ...params, credential, installation });
  }

  /**
   * What the edit dialog shows for an organization subscription: its
   * organization, App, key fingerprint and model count. Nothing secret.
   */
  async summary(params: Owner & { keyId: string }) {
    const credential = await this.storedCredential(params, "read");
    const organization = await githubAppOrganization(credential);
    const app = await fetchAsGithubApp<{ name?: string; slug?: string }>({
      githubUrl: githubAppApiBase(credential),
      appId: credential.appId,
      privateKey: credential.privateKey,
      path: "/app",
    }).catch(() => null);
    const models = await LlmProviderApiKeyModelLinkModel.getModelsForApiKey(
      params.keyId,
    );
    return {
      organization,
      appId: credential.appId,
      appName: app?.name ?? null,
      fingerprint: githubAppKeyFingerprint(credential.privateKey),
      modelCount: models.length,
    };
  }

  /** Replace the private key of an organization subscription's App. */
  async replacePrivateKey(
    params: Owner & { keyId: string; privateKey: string },
  ) {
    const credential = await this.storedCredential(params, "update");
    const organization =
      (await githubAppOrganization(credential)) ?? credential.organization;
    if (!organization)
      throw new ApiError(
        400,
        "The App's organization is unknown. Use Reconnect to enter the App again.",
      );
    return this.connectExisting({
      ...params,
      githubUrl: credential.githubUrl ?? "https://github.com",
      appId: credential.appId,
      organization,
      privateKey: params.privateKey,
      replaceKeyId: params.keyId,
    });
  }

  /**
   * Check that Copilot answers the App, then store it: a new shared key, or
   * the replaced credentials of an existing one.
   */
  private async connect(
    params: Owner & {
      credential: GithubAppCredential;
      installation: Installation;
      grants?: ResourcePermissionGrant[];
      replaceKeyId?: string;
    },
  ) {
    const { credential, installation, organizationId, userId } = params;
    const organization = credential.organization ?? "the organization";
    if (
      installation.permissions &&
      !installation.permissions.organization_copilot_requests
    )
      throw new ApiError(
        400,
        `The App on ${organization} doesn't have the Copilot Requests permission. Add "Copilot Requests: Read-only" under the App's organization permissions, then approve the change on ${organization}.`,
      );
    const apiKey = encodeGithubAppCredential(credential);
    const models = await fetchCopilotModelIds(apiKey);

    let keyId: string;
    if (params.replaceKeyId) {
      const existing = await LlmProviderApiKeyModel.findById(
        params.replaceKeyId,
      );
      if (
        !existing ||
        existing.organizationId !== organizationId ||
        !(await LlmProviderApiKeyModel.isGithubAppKey(existing.id))
      )
        throw new ApiError(404, "Organization subscription not found");
      await ResourcePermissions.require({
        organizationId,
        userId,
        resource: "llmProviderApiKey",
        scope: existing.id,
        action: "update",
      });
      if (existing.secretId) {
        await secretManager().updateSecret(existing.secretId, { apiKey });
      } else {
        const secret = await secretManager().createSecret(
          { apiKey },
          SECRET_NAME,
        );
        await LlmProviderApiKeyModel.update(existing.id, {
          secretId: secret.id,
        });
      }
      await LlmProviderApiKeyModel.recordCredentialKind({
        id: existing.id,
        apiKeyValue: apiKey,
      });
      // New credentials that Copilot accepted: the key works again.
      await LlmProviderApiKeyModel.setRequiresReauthentication({
        id: existing.id,
        requiresReauthentication: false,
      });
      keyId = existing.id;
    } else {
      const grants = params.grants ?? EVERYONE_IN_ORGANIZATION;
      if (grants.length)
        await ResourcePermissions.validateInitialGrants({
          organizationId,
          userId,
          resource: "llmProviderApiKey",
          grants,
          target: {
            id: randomUUID(),
            name: keyName(credential),
            authorId: null,
          },
        });
      const secret = await secretManager().createSecret(
        { apiKey },
        SECRET_NAME,
      );
      try {
        const created = await LlmProviderApiKeyModel.create(
          {
            organizationId,
            createdBy: userId,
            name: keyName(credential),
            provider: "github-copilot",
            secretId: secret.id,
            baseUrl: null,
            inferenceBaseUrl: null,
            extraHeaders: null,
            scope: "org",
            userId: null,
            teamId: null,
            isPrimary: false,
          },
          { initialPermissionGrants: grants, apiKeyValue: apiKey },
        );
        keyId = created.id;
      } catch (error) {
        await secretManager()
          .deleteSecret(secret.id)
          .catch(() => undefined);
        throw error;
      }
    }

    try {
      await modelSyncService.syncModelsForApiKey({
        apiKeyId: keyId,
        provider: "github-copilot",
        apiKeyValue: apiKey,
        baseUrl: null,
        extraHeaders: null,
      });
    } catch (error) {
      logger.error(
        { error, apiKeyId: keyId },
        "Model sync failed for the Copilot organization subscription",
      );
    }
    const linked =
      await LlmProviderApiKeyModelLinkModel.getModelsForApiKey(keyId);
    return {
      status: "installed" as const,
      id: keyId,
      organization,
      modelIds: linked.length
        ? linked.map((model) => model.modelId).sort()
        : models,
    };
  }

  /** The App credential of an organization subscription the user may access. */
  private async storedCredential(
    params: Owner & { keyId: string },
    action: "read" | "update",
  ): Promise<GithubAppCredential> {
    const key = await LlmProviderApiKeyModel.findById(params.keyId);
    if (
      !key?.secretId ||
      key.organizationId !== params.organizationId ||
      !(await LlmProviderApiKeyModel.isGithubAppKey(key.id))
    )
      throw new ApiError(404, "Organization subscription not found");
    await ResourcePermissions.require({
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "llmProviderApiKey",
      scope: key.id,
      action,
    });
    const credential = decodeGithubAppCredential(
      (await getSecretValueForLlmProviderApiKey(key.secretId)) as
        | string
        | undefined,
    );
    if (!credential)
      throw new ApiError(
        400,
        "The stored GitHub App credential is unreadable.",
      );
    return credential;
  }

  private fetchAsPending<T>(pending: StoredPendingApp, path: `/app${string}`) {
    const { privateKey } = SecretSchema.parse(
      decryptSecretValue(pending.secret),
    );
    return fetchAsGithubApp<T>({
      githubUrl: pending.api,
      appId: pending.appId,
      privateKey,
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
}

export const copilotGithubAppSetup = new CopilotGithubAppSetup();

// ===================== Internals =====================

type Owner = { organizationId: string; userId: string };

const NOT_AN_ORGANIZATION =
  "GitHub Copilot needs an organization on Copilot Business or Enterprise.";
const SECRET_NAME = "chatapikey-org-github-copilot-app";
const START_TTL_MS = 30 * 60_000;
// GitHub's manifest code lives an hour; installing usually follows within minutes.
const PENDING_TTL_MS = 60 * 60_000;

const EVERYONE_IN_ORGANIZATION: ResourcePermissionGrant[] = [
  { subject: { type: "organization", id: "*" }, actions: ["read", "use"] },
];

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
  pem: z.string().min(1),
  html_url: z.string().url(),
  owner: z.object({
    login: z.string(),
    id: z.number().int(),
    type: z.string(),
  }),
});
const SecretSchema = z.object({ privateKey: z.string().min(1) });
const StoredPendingAppSchema = z.object({
  appId: z.string(),
  name: z.string(),
  slug: z.string(),
  account: z.string(),
  accountId: z.number().int(),
  htmlUrl: z.string(),
  web: z.string(),
  api: z.string(),
  secret: z.object({ __encrypted: z.string() }),
});
type StoredPendingApp = z.infer<typeof StoredPendingAppSchema>;
type Installation = {
  id: number;
  account: { login: string; id: number } | null;
  permissions?: Record<string, string>;
};
const AccountSchema = z.object({
  login: z.string(),
  type: z.enum(["User", "Organization"]),
});

function manifest(params: { appName: string }) {
  const { appName } = params;
  const callbackUrl = `${config.frontendBaseUrl}/github/copilot-app-setup`;
  return {
    // App names are unique across GitHub; the create page lets the admin rename it.
    name: `${appName} Copilot`,
    description: `Lets ${appName} make GitHub Copilot requests paid from this organization's Copilot plan. It reads no code, repositories, issues or members.`,
    url: config.frontendBaseUrl,
    redirect_url: callbackUrl,
    setup_url: callbackUrl,
    public: false,
    default_permissions: { organization_copilot_requests: "read" },
    default_events: [],
  };
}

function keyName(credential: GithubAppCredential) {
  return `GitHub Copilot (${credential.organization ?? "organization"})`;
}

function toPublic(pending: StoredPendingApp): PendingCopilotGithubApp {
  const installUrl = new URL(
    `${pending.htmlUrl.replace(/\/+$/, "")}/installations/new/permissions`,
  );
  installUrl.searchParams.set("target_id", String(pending.accountId));
  return {
    name: pending.name,
    slug: pending.slug,
    organization: pending.account,
    appId: pending.appId,
    installUrl: installUrl.toString(),
    settingsUrl: `${pending.web}/organizations/${encodeURIComponent(pending.account)}/settings/apps/${encodeURIComponent(pending.slug)}`,
  };
}

/**
 * The chat models Copilot lists for the App, read before anything is stored
 * so a key that can't reach Copilot is never created.
 */
async function fetchCopilotModelIds(apiKey: string): Promise<string[]> {
  const copilotFetch = createGithubCopilotFetch({ githubToken: apiKey });
  const response = await copilotFetch(
    `${config.llm["github-copilot"].baseUrl.replace(/\/+$/, "")}/models`,
  );
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // keep the raw text
    }
    throw new ApiError(
      400,
      message || `GitHub Copilot answered ${response.status}`,
    );
  }
  const payload = (await response.json()) as {
    data?: Array<{ id: string; capabilities?: { type?: string } }>;
  };
  return (payload.data ?? [])
    .filter((model) => (model.capabilities?.type ?? "chat") === "chat")
    .map((model) => model.id)
    .sort();
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function flowIdentifier(owner: Owner, step: "start" | "pending") {
  return `github-copilot-app:${step}:${JSON.stringify([owner.organizationId, owner.userId])}`;
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
