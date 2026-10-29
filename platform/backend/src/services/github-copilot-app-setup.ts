import { randomUUID } from "node:crypto";
import {
  GITHUB_ACCOUNT_INPUT_INVALID,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { fetchAsGithubApp } from "@/integrations/github/app-auth";
import { parseGitHubAppSecrets } from "@/integrations/github/app-secrets";
import logger from "@/logging";
import {
  AuditLogModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
  UserModel,
} from "@/models";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import {
  deleteRuntimeCredentialDefinition,
  getRuntimeCredentialConnectionAuditSnapshot,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import {
  decodeGithubAppReference,
  encodeGithubAppReference,
  forgetGithubAppReference,
  type GithubAppCredential,
  githubAppApiBase,
  githubAppKeyFingerprint,
  githubWebFromApi,
  resolveGithubAppCredential,
  validateGithubAppPrivateKey,
} from "@/services/github-app-copilot-token";
import {
  type GithubAppInstallation,
  githubAppManifestSetup,
  isAppGone,
  lookupAccount,
  parseAccount,
} from "@/services/github-app-manifest-setup";
import { assertModelProviderAllowed } from "@/services/integration-overrides";
import { modelSyncService } from "@/services/model-sync";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import { createGithubCopilotFetch } from "./github-copilot-token";

/**
 * Connects GitHub Copilot paid by a GitHub organization, as a shared
 * `github-copilot` provider key. The App behind it is a GitHub App credential,
 * in the organization's runtime credentials; the key references it with the App's
 * installation on the organization. Three ways to get there:
 *
 * - an App already connected to the organization (`connectFromCredential`),
 * - a new App registered from a manifest (the shared manifest setup, then
 *   `install`),
 * - an App by its ID and private key (`connectByKey`), saved as a credential.
 */
class CopilotGithubAppSetup {
  /** Start registering a new App on the organization. */
  async start(params: Owner & { organization: string }) {
    await assertCopilotAllowed(params);
    return githubAppManifestSetup.start({ ...params, flow: "copilot" });
  }

  /** GitHub's return from creating the App: exchange its code for the App. */
  async complete(params: Owner & { code: string; state: string }) {
    return (await githubAppManifestSetup.complete(params)).app;
  }

  pending(params: Owner) {
    return githubAppManifestSetup.pending({ ...params, flow: "copilot" });
  }

  discard(params: Owner) {
    return githubAppManifestSetup.discard(params);
  }

  /** Once the new App is installed: save it as a credential, then the key. */
  async install(
    params: Owner & {
      grants?: ResourcePermissionGrant[];
      /** Put the new App on this key instead of adding a key. */
      replaceKeyId?: string;
      name?: string;
    },
  ) {
    await assertCopilotAllowed(params);
    const found = await githubAppManifestSetup.installation({
      ...params,
      flow: "copilot",
    });
    if (found.status === "waiting") return found;
    const { app, installation } = found;
    // Check Copilot answers the App before anything is saved.
    assertCopilotRequests(installation, app.account);
    if (params.replaceKeyId) {
      const { login } = parseAccount(await this.organizationInput(params));
      if (login.toLowerCase() !== app.account.toLowerCase())
        throw new ApiError(
          400,
          `This plan is for ${login}, but the new App is installed on ${app.account}.`,
        );
    }
    const models = await fetchCopilotModelIds({
      appId: app.appId,
      installationId: String(installation.id),
      privateKey: app.secret.privateKey,
      githubUrl: app.web,
      organization: app.account,
    });
    const definition = await githubAppManifestSetup.saveCredential({
      ...params,
      app,
      installationId: String(installation.id),
      description: `Makes GitHub Copilot requests for ${app.account}.`,
      icon: "logo:github",
      value: JSON.stringify(app.secret),
    });
    await githubAppManifestSetup.discard(params);
    return this.connect({
      ...params,
      reference: {
        ref: {
          organizationId: params.organizationId,
          credentialId: definition.id,
        },
        installationId: String(installation.id),
        organization: app.account,
        githubUrl: app.web,
      },
      installation,
      models,
    });
  }

  /**
   * Check that what a person typed names a GitHub organization, before a step
   * uses it: the same parsing and account check as `start`.
   */
  async checkOrganization(params: Owner & { organization: string }) {
    await assertCopilotAllowed(params);
    // Only provider keys: someone who can just reuse a connected App must get
    // past this step too. The https-only parse below bounds what it fetches.
    await authorize(params, ["llmProviderApiKey"]);
    const { api, login } = parseAccount(params.organization);
    const account = await lookupAccount({ api, login });
    if (account.type !== "Organization")
      throw new ApiError(400, NOT_AN_ORGANIZATION);
    return { organization: account.login };
  }

  /**
   * Use a GitHub App already connected to the organization. When its
   * installation lacks Copilot Requests, say where to add it instead of
   * failing.
   */
  async connectFromCredential(
    params: Owner & {
      credentialId: string;
      organization?: string;
      replaceKeyId?: string;
      grants?: ResourcePermissionGrant[];
      name?: string;
    },
  ) {
    await assertCopilotAllowed(params);
    const definition = await RuntimeCredentialDefinitionModel.findById({
      id: params.credentialId,
      organizationId: params.organizationId,
    });
    if (
      definition?.kind !== "github_app" ||
      !definition.allowOrganization ||
      !definition.appId
    )
      throw new ApiError(404, "GitHub App not found");
    await ResourcePermissions.require({
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "credential",
      scope: definition.id,
      action: "read",
    });
    const privateKey = await RuntimeCredentialConnectionModel.resolveValue({
      organizationId: params.organizationId,
      credentialId: definition.key,
      scope: "organization",
    });
    if (!privateKey)
      throw new ApiError(
        400,
        `${definition.name} has no private key connected. Connect it in Settings, or connect an App by its ID and private key.`,
      );
    const api = (definition.githubUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    const { login } = parseAccount(await this.organizationInput(params));
    const installation = await findInstallation({
      api,
      appId: definition.appId,
      privateKey,
      login,
      appName: definition.name,
    });
    if (!installation.permissions?.organization_copilot_requests) {
      const app = await fetchAsGithubApp<{
        slug?: string;
        owner?: { login: string; type?: string };
      }>({
        githubUrl: api,
        appId: definition.appId,
        privateKey,
        path: "/app",
      }).catch(() => null);
      const web = githubWebFromApi(api);
      const owner = app?.owner?.login ?? login;
      return {
        status: "needs_permission" as const,
        appName: definition.name,
        organization: installation.account?.login ?? login,
        settingsUrl: app?.slug
          ? app.owner?.type === "User"
            ? `${web}/settings/apps/${encodeURIComponent(app.slug)}`
            : `${web}/organizations/${encodeURIComponent(owner)}/settings/apps/${encodeURIComponent(app.slug)}`
          : `${web}/organizations/${encodeURIComponent(owner)}/settings/installations/${installation.id}`,
      };
    }
    return this.connect({
      ...params,
      reference: {
        ref: {
          organizationId: params.organizationId,
          credentialId: definition.id,
        },
        installationId: String(installation.id),
        organization: installation.account?.login ?? login,
        githubUrl: githubWebFromApi(api),
      },
      installation,
      models: await fetchCopilotModelIds({
        appId: definition.appId,
        installationId: String(installation.id),
        privateKey,
        githubUrl: githubWebFromApi(api),
        organization: installation.account?.login ?? login,
      }),
    });
  }

  /** Check an App by its ID and private key, and its installation on the organization. */
  async validateExisting(
    params: Owner & {
      appId: string;
      organization?: string;
      privateKey: string;
      replaceKeyId?: string;
    },
  ) {
    await assertCopilotAllowed(params);
    const { appId, privateKey, fingerprint } =
      validateGithubAppPrivateKey(params);
    const { web, api, login } = parseAccount(
      await this.organizationInput(params),
    );
    const installation = await findInstallation({
      api,
      appId,
      privateKey,
      login,
      appName: `App ${appId}`,
    });
    return {
      fingerprint,
      installationId: String(installation.id),
      organization: installation.account?.login ?? login,
      web,
      api,
      appId,
      privateKey,
      installation,
    };
  }

  /**
   * Connect an App that is not connected to the organization yet, by its ID
   * and private key. It is saved as a GitHub App credential like a created one.
   */
  async connectByKey(
    params: Owner & {
      appId: string;
      organization?: string;
      privateKey: string;
      replaceKeyId?: string;
      grants?: ResourcePermissionGrant[];
      name?: string;
    },
  ) {
    await assertCopilotAllowed(params);
    await authorize(params);
    const checked = await this.validateExisting(params);
    // Check Copilot answers the App before anything is saved.
    assertCopilotRequests(checked.installation, checked.organization);
    const models = await fetchCopilotModelIds({
      appId: checked.appId,
      installationId: checked.installationId,
      privateKey: checked.privateKey,
      githubUrl: checked.web,
      organization: checked.organization,
    });
    const app = await fetchAsGithubApp<{ name?: string; slug?: string }>({
      githubUrl: checked.api,
      appId: checked.appId,
      privateKey: checked.privateKey,
      path: "/app",
    }).catch(() => null);
    // The organization keeps one credential per App: a known App gets its
    // new private key, an unknown one a new credential.
    const known = await this.knownAppCredential({
      organizationId: params.organizationId,
      appId: checked.appId,
      api: checked.api,
    });
    // The key's own checks come first: a refused connect must not have
    // touched an App credential other plans and features share.
    await this.assertCanStore({
      ...params,
      organization: checked.organization,
    });
    const previousValue = known
      ? await this.replaceAppPrivateKey({
          ...params,
          definition: known,
          privateKey: checked.privateKey,
        })
      : null;
    const definition =
      known ??
      (await githubAppManifestSetup.saveCredential({
        ...params,
        app: {
          name: app?.name ?? `GitHub App ${checked.appId}`,
          slug: app?.slug ?? checked.appId,
          appId: checked.appId,
          api: checked.api,
        },
        installationId: checked.installationId,
        description: `Makes GitHub Copilot requests for ${checked.organization}.`,
        icon: "logo:github",
        value: checked.privateKey,
      }));
    try {
      return await this.connect({
        ...params,
        reference: {
          ref: {
            organizationId: params.organizationId,
            credentialId: definition.id,
          },
          installationId: checked.installationId,
          organization: checked.organization,
          githubUrl: checked.web,
        },
        installation: checked.installation,
        models,
      });
    } catch (error) {
      // A credential made for this connect alone goes with it; a known App
      // gets its previous private key back.
      if (!known)
        await deleteRuntimeCredentialDefinition({
          organizationId: params.organizationId,
          key: definition.key,
        }).catch(() => undefined);
      else if (previousValue)
        await this.restoreAppConnection({
          ...params,
          definition: known,
          value: previousValue,
        }).catch((restoreError) =>
          logger.error(
            { err: restoreError, credentialId: known.id },
            "[CopilotGithubApp] could not restore the App's previous private key",
          ),
        );
      throw error;
    }
  }

  /**
   * What the edit dialog shows for an organization's GitHub Copilot key: its
   * organization, App, key fingerprint and model count. Nothing secret.
   */
  async summary(params: Owner & { keyId: string }) {
    const stored = await this.storedValue(params, "read");
    const reference = decodeGithubAppReference(stored.value);
    const credential = await resolveGithubAppCredential({
      value: stored.value,
      organizationId: params.organizationId,
    });
    if (!reference || !credential)
      throw new ApiError(
        400,
        "The stored GitHub App credential is unreadable.",
      );
    const definition = await RuntimeCredentialDefinitionModel.findById({
      id: reference.ref.credentialId,
      organizationId: reference.ref.organizationId,
    });
    // GitHub's page for the App; the stored credential holds no link to it.
    const app = await fetchAsGithubApp<{ name?: string; html_url?: string }>({
      githubUrl: githubAppApiBase(credential),
      appId: credential.appId,
      privateKey: credential.privateKey,
      path: "/app",
    }).catch(() => null);
    return {
      organization: reference.organization,
      appId: credential.appId,
      appName: definition?.name ?? app?.name ?? null,
      appIcon: definition?.icon ?? null,
      appUrl: app?.html_url ?? null,
      githubUrl: credential.githubUrl ?? "https://github.com",
      fingerprint: githubAppKeyFingerprint(credential.privateKey),
    };
  }

  /**
   * Check that Copilot answers the App, then store the key: a new shared key,
   * or a key whose App was replaced.
   */
  private async connect(
    params: Owner & {
      reference: Parameters<typeof encodeGithubAppReference>[0];
      installation: GithubAppInstallation;
      grants?: ResourcePermissionGrant[];
      replaceKeyId?: string;
      name?: string;
      /** The App's chat models, read before anything is stored. */
      models: string[];
    },
  ) {
    assertCopilotRequests(params.installation, params.reference.organization);
    return this.storeKey({
      ...params,
      apiKey: encodeGithubAppReference(params.reference),
      organization: params.reference.organization,
    });
  }

  private async storeKey(
    params: Owner & {
      apiKey: string;
      organization: string;
      grants?: ResourcePermissionGrant[];
      replaceKeyId?: string;
      /** The App's chat models, read before anything is stored. */
      models: string[];
      /** A new key's name; a replaced key keeps its own. */
      name?: string;
    },
  ) {
    const { apiKey, organization, organizationId, userId, models } = params;

    let keyId: string;
    if (params.replaceKeyId) {
      const existing = await this.ownKey(
        { ...params, keyId: params.replaceKeyId },
        "update",
      );
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
      // An App that Copilot accepted: the key works again.
      await LlmProviderApiKeyModel.setRequiresReauthentication({
        id: existing.id,
        requiresReauthentication: false,
      });
      keyId = existing.id;
    } else {
      const grants = params.grants ?? EVERYONE_IN_ORGANIZATION;
      const name = params.name?.trim() || `GitHub Copilot (${organization})`;
      if (grants.length)
        await ResourcePermissions.validateInitialGrants({
          organizationId,
          userId,
          resource: "llmProviderApiKey",
          grants,
          target: { id: randomUUID(), name, authorId: null },
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
            name,
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
        "Model sync failed for the Copilot enterprise plan",
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

  /** The organization's GitHub App credential for this App on this GitHub, if any. */
  private async knownAppCredential(params: {
    organizationId: string;
    appId: string;
    api: string;
  }) {
    const normalize = (url: string | null) =>
      (url ?? "https://api.github.com").replace(/\/+$/, "");
    return (
      (await RuntimeCredentialDefinitionModel.list(params.organizationId)).find(
        (definition) =>
          definition.kind === "github_app" &&
          definition.allowOrganization &&
          definition.appId === params.appId &&
          normalize(definition.githubUrl) === normalize(params.api),
      ) ?? null
    );
  }

  /**
   * Put a new private key on a known App's credential, keeping its stored
   * shape (a bare PEM, or the PEM with the OAuth client secret). Audited as
   * a credential update; returns the value it replaced.
   */
  private async replaceAppPrivateKey(
    params: Owner & {
      definition: { id: string; key: string; name: string };
      privateKey: string;
    },
  ) {
    try {
      await ResourcePermissions.require({
        organizationId: params.organizationId,
        userId: params.userId,
        resource: "credential",
        scope: params.definition.id,
        action: "update",
      });
    } catch {
      throw new ApiError(
        403,
        `${params.definition.name} is already connected, and you can't change its private key. Ask someone who can, or pick it under Use an App I already have.`,
      );
    }
    const current = await RuntimeCredentialConnectionModel.resolveValue({
      organizationId: params.organizationId,
      credentialId: params.definition.key,
      scope: "organization",
    });
    const clientSecret = current
      ? parseGitHubAppSecrets(current).clientSecret
      : undefined;
    await this.restoreAppConnection({
      ...params,
      value: clientSecret
        ? JSON.stringify({ privateKey: params.privateKey, clientSecret })
        : params.privateKey,
    });
    return current;
  }

  /** Write an App credential's connection value, audited as its update. */
  private async restoreAppConnection(
    params: Owner & {
      definition: { id: string; key: string; name: string };
      value: string;
    },
  ) {
    const snapshot = () =>
      getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: params.organizationId,
        credentialId: params.definition.key,
        scope: "organization",
      });
    const before = await snapshot();
    await setRuntimeCredentialConnection({
      organizationId: params.organizationId,
      userId: params.userId,
      credentialId: params.definition.key,
      scope: "organization",
      value: params.value,
    });
    forgetGithubAppReference({
      organizationId: params.organizationId,
      credentialId: params.definition.id,
    });
    const actor = await UserModel.getById(params.userId);
    await AuditLogModel.create({
      organizationId: params.organizationId,
      actorId: params.userId,
      actorType: "user",
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      action: "credential.updated",
      outcome: "success",
      resourceType: "credential",
      resourceId: params.definition.key,
      resourceName: params.definition.name,
      before,
      after: await snapshot(),
      httpMethod: "POST",
      httpPath: "/api/github-copilot-app/existing",
      httpRoute: "/api/github-copilot-app/existing",
      httpStatus: null,
      requestId: null,
      sourceIp: null,
      userAgent: null,
      occurredAt: new Date(),
    }).catch((err) =>
      logger.error(
        { err },
        "audit: failed to record the App credential update",
      ),
    );
  }

  /**
   * The checks storing the plan key will make, run before anything else is
   * written: the user may update the key being reconnected, or grant the new
   * key's initial access.
   */
  private async assertCanStore(
    params: Owner & {
      organization: string;
      replaceKeyId?: string;
      grants?: ResourcePermissionGrant[];
      name?: string;
    },
  ) {
    if (params.replaceKeyId) {
      await this.ownKey({ ...params, keyId: params.replaceKeyId }, "update");
      return;
    }
    const grants = params.grants ?? EVERYONE_IN_ORGANIZATION;
    if (grants.length)
      await ResourcePermissions.validateInitialGrants({
        organizationId: params.organizationId,
        userId: params.userId,
        resource: "llmProviderApiKey",
        grants,
        target: {
          id: randomUUID(),
          name:
            params.name?.trim() || `GitHub Copilot (${params.organization})`,
          authorId: null,
        },
      });
  }

  /** An organization's GitHub Copilot key the user may act on. */
  private async ownKey(
    params: Owner & { keyId: string },
    action: "read" | "update",
  ) {
    const key = await LlmProviderApiKeyModel.findById(params.keyId);
    if (
      !key ||
      key.organizationId !== params.organizationId ||
      !(await LlmProviderApiKeyModel.isGithubAppKey(key.id))
    )
      throw new ApiError(404, "Enterprise plan not found");
    await ResourcePermissions.require({
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "llmProviderApiKey",
      scope: key.id,
      action,
    });
    return key;
  }

  /** The key's stored value: a reference to its GitHub App credential. */
  private async storedValue(
    params: Owner & { keyId: string },
    action: "read" | "update",
  ) {
    const key = await this.ownKey(params, action);
    const value = key.secretId
      ? ((await getSecretValueForLlmProviderApiKey(key.secretId)) as
          | string
          | undefined)
      : undefined;
    if (!value)
      throw new ApiError(
        400,
        "The stored GitHub App credential is unreadable.",
      );
    return { key, value };
  }

  /**
   * The organization a step names: what the person typed, or, reconnecting a
   * key, the organization stored on it with its GitHub address. Read from the
   * key alone, so it works after the App's credential was deleted.
   */
  private async organizationInput(
    params: Owner & { organization?: string; replaceKeyId?: string },
  ): Promise<string> {
    if (params.organization) return params.organization;
    if (!params.replaceKeyId)
      throw new ApiError(400, GITHUB_ACCOUNT_INPUT_INVALID);
    const { value } = await this.storedValue(
      { ...params, keyId: params.replaceKeyId },
      "update",
    );
    const reference = decodeGithubAppReference(value);
    if (!reference)
      throw new ApiError(
        400,
        "The stored GitHub App credential is unreadable.",
      );
    return `${reference.githubUrl}/${reference.organization}`;
  }
}

export const copilotGithubAppSetup = new CopilotGithubAppSetup();

/**
 * The organization's GitHub Copilot keys that use a GitHub App credential, to
 * block deleting the credential the way other in-use credentials are.
 */
export async function copilotKeysUsingCredential(params: {
  organizationId: string;
  credentialId: string;
}): Promise<Array<{ id: string; name: string }>> {
  const keys = await LlmProviderApiKeyModel.findGithubAppKeyValues(
    params.organizationId,
  );
  return keys.flatMap((key) => {
    const reference = decodeGithubAppReference(key.value);
    return reference?.ref.credentialId === params.credentialId
      ? [{ id: key.id, name: `GitHub Copilot for ${reference.organization}` }]
      : [];
  });
}

// ===================== Internals =====================

type Owner = { organizationId: string; userId: string };

const NOT_AN_ORGANIZATION =
  "GitHub Copilot needs an organization on Copilot Business or Enterprise.";
const SECRET_NAME = "chatapikey-org-github-copilot-app";

const EVERYONE_IN_ORGANIZATION: ResourcePermissionGrant[] = [
  { subject: { type: "organization", id: "*" }, actions: ["read", "use"] },
];

githubAppManifestSetup.register("copilot", {
  allowPersonal: false,
  organizationRequired: NOT_AN_ORGANIZATION,
  authorize,
  manifest: ({ appName }) => ({
    // App names are unique across GitHub; the create page lets the admin rename it.
    name: `${appName} Copilot`,
    description: `Lets ${appName} make GitHub Copilot requests paid from this organization's Copilot plan. It reads no code, repositories, issues or members.`,
    url: config.frontendBaseUrl,
    // GitHub returns to Model Providers, which finishes the setup.
    redirect_url: `${config.frontendBaseUrl}/llm/model-providers/github-app`,
    setup_url: `${config.frontendBaseUrl}/llm/model-providers/github-app`,
    public: false,
    default_permissions: { organization_copilot_requests: "read" },
    default_events: [],
  }),
});

/**
 * Admins can turn GitHub Copilot off for the organization: then no plan is
 * set up, connected or reconnected.
 */
async function assertCopilotAllowed(owner: Owner) {
  await assertModelProviderAllowed({
    organizationId: owner.organizationId,
    provider: "github-copilot",
  });
}

/** Saving a GitHub App credential and a shared key both need permission. */
async function authorize(
  owner: Owner,
  resources: ("llmProviderApiKey" | "credential")[] = [
    "llmProviderApiKey",
    "credential",
  ],
) {
  for (const resource of resources)
    if (
      !(await userHasPermission(
        owner.userId,
        owner.organizationId,
        resource,
        "create",
      ))
    )
      throw new ApiError(
        403,
        resources.includes("credential")
          ? "You need permission to create provider keys and credentials."
          : "You need permission to create provider keys.",
      );
}

/** The App's installation on the organization, or a message that says how to install it. */
async function findInstallation(params: {
  api: string;
  appId: string;
  privateKey: string;
  login: string;
  appName: string;
}): Promise<GithubAppInstallation> {
  let installations: GithubAppInstallation[];
  try {
    installations = await fetchAsGithubApp<GithubAppInstallation[]>({
      githubUrl: params.api,
      appId: params.appId,
      privateKey: params.privateKey,
      path: "/app/installations",
    });
  } catch (error) {
    if (isAppGone(error))
      throw new ApiError(
        400,
        `GitHub doesn't recognize App ${params.appId} with this private key. Check the App ID and download a current private key from the App settings.`,
      );
    throw error;
  }
  const installation = installations.find(
    (entry) =>
      entry.account?.login.toLowerCase() === params.login.toLowerCase(),
  );
  if (!installation?.account)
    throw new ApiError(
      400,
      `${params.appName} isn't installed on ${params.login}. Install it on the organization on GitHub, then try again.`,
    );
  if (installation.account.type === "User")
    throw new ApiError(400, NOT_AN_ORGANIZATION);
  return installation;
}

function assertCopilotRequests(
  installation: GithubAppInstallation,
  organization: string,
) {
  if (
    installation.permissions &&
    !installation.permissions.organization_copilot_requests
  )
    throw new ApiError(
      400,
      `The App on ${organization} doesn't have the Copilot Requests permission. Add "Copilot Requests: Read-only" under the App's organization permissions, then approve the change on ${organization}.`,
    );
}

/**
 * The chat models Copilot lists for the App, read before anything is stored
 * so a key that can't reach Copilot is never created.
 */
async function fetchCopilotModelIds(
  appCredential: GithubAppCredential,
): Promise<string[]> {
  const copilotFetch = createGithubCopilotFetch({
    githubToken: undefined,
    appCredential,
  });
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
