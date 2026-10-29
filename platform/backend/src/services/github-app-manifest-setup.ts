import { createHash, randomBytes } from "node:crypto";
import {
  GITHUB_ACCOUNT_INPUT_INVALID,
  getGithubWebOrigin,
  parseGithubAccountInput,
} from "@archestra/shared";
import { z } from "zod";
import {
  fetchAsGithubApp,
  GITHUB_APP_NOT_FOUND,
} from "@/integrations/github/app-auth";
import logger from "@/logging";
import {
  OrganizationModel,
  RuntimeCredentialDefinitionModel,
  VerificationModel,
} from "@/models";
import {
  createRuntimeCredentialDefinition,
  deleteRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { ApiError } from "@/types";
import type { PendingGithubApp } from "@/types/github-app-manifest-setup";
import { decryptSecretValue, encryptSecretValue } from "@/utils/crypto";

/**
 * Registers a GitHub App from a manifest so nobody copies an App ID,
 * installation ID or private key by hand. GitHub Copilot enterprise plans
 * use it as a flow with its own manifest and install step:
 *
 * 1. `start` returns the manifest the browser posts to GitHub.
 * 2. GitHub creates the App and returns a one-time code; `complete` trades it
 *    for the App's credentials and holds them, encrypted, until installed.
 *    The flow saved with the state says whose App it is, so one return page
 *    serves every flow.
 * 3. `installation` finds where the App is installed; the flow then stores
 *    it, usually through `saveCredential`.
 */
class GithubAppManifestSetup {
  register(flow: GithubAppSetupFlow, config: GithubAppFlowConfig) {
    this.flows.set(flow, config);
  }

  async start(
    params: Owner & { flow: GithubAppSetupFlow; organization: string },
  ) {
    const config = this.config(params.flow);
    await config.authorize(params);
    const { web, api, login } = parseAccount(params.organization);
    const account = await lookupAccount({ api, login });
    if (account.type !== "Organization" && !config.allowPersonal)
      throw new ApiError(400, config.organizationRequired);
    const state = randomBytes(32).toString("base64url");
    const identifier = flowIdentifier(params, "start");
    await VerificationModel.deleteByIdentifier(identifier);
    await VerificationModel.create({
      identifier,
      expiresAt: new Date(Date.now() + START_TTL_MS),
      value: JSON.stringify({
        flow: params.flow,
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
        config.manifest({
          appName: await OrganizationModel.getAppName(),
          api,
        }),
      ),
    };
  }

  /** Trade GitHub's one-time code for the App, for whichever flow started it. */
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
    const config = this.config(flow.data.flow);
    await config.authorize(params);
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
        { status: response.status, flow: flow.data.flow },
        "GitHub App manifest conversion failed",
      );
      throw new ApiError(
        502,
        "GitHub didn't return the new App. Start again; codes expire after an hour.",
      );
    }
    if (app.data.owner.type !== "Organization" && !config.allowPersonal)
      throw new ApiError(400, config.organizationRequired);
    if (app.data.owner.login.toLowerCase() !== flow.data.owner.toLowerCase())
      throw new ApiError(
        400,
        `The App was created for ${app.data.owner.login}, not ${flow.data.owner}. Sign in to GitHub as ${flow.data.owner} and start again.`,
      );
    const pending: StoredPendingApp = {
      flow: flow.data.flow,
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
    return { flow: pending.flow, app: toPublic(pending) };
  }

  /** The App this flow created, while it still awaits installation. */
  async pending(
    params: Owner & { flow: GithubAppSetupFlow },
  ): Promise<PendingGithubApp | null> {
    const pending = await this.loadPending(params);
    if (!pending || pending.flow !== params.flow) return null;
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

  /**
   * Where the App this flow created is installed on its account, with what it
   * needs to sign in. `waiting` until GitHub reports the installation.
   */
  async installation(params: Owner & { flow: GithubAppSetupFlow }): Promise<
    | { status: "waiting" }
    | {
        status: "installed";
        app: PendingGithubAppDetails;
        installation: GithubAppInstallation;
      }
  > {
    await this.config(params.flow).authorize(params);
    const pending = await this.loadPending(params);
    if (!pending || pending.flow !== params.flow)
      throw new ApiError(
        400,
        "GitHub App setup expired. Create the App again.",
      );
    let installations: GithubAppInstallation[];
    try {
      installations = await this.fetchAsPending<GithubAppInstallation[]>(
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
    if (!installation) return { status: "waiting" };
    return {
      status: "installed",
      installation,
      app: {
        ...pending,
        secret: SecretSchema.parse(decryptSecretValue(pending.secret)),
      },
    };
  }

  /**
   * Save a GitHub App as an organization credential, the one store both
   * flows share. A failed connection leaves no credential behind.
   */
  async saveCredential(
    params: Owner & {
      app: {
        name: string;
        slug: string;
        appId: string;
        api: string;
        clientId?: string;
      };
      installationId: string;
      description: string;
      icon: string;
      /** The connection value: the PEM, or the PEM with the OAuth client secret. */
      value: string;
    },
  ) {
    const definition = await createRuntimeCredentialDefinition({
      organizationId: params.organizationId,
      userId: params.userId,
      definition: {
        key: await freeKey(params.organizationId, params.app.slug),
        kind: "github_app",
        name: params.app.name,
        description: params.description,
        icon: params.icon,
        allowPersonal: false,
        allowOrganization: true,
        githubUrl: params.app.api,
        appId: params.app.appId,
        installationId: params.installationId,
        ...(params.app.clientId ? { githubClientId: params.app.clientId } : {}),
      },
    });
    try {
      await setRuntimeCredentialConnection({
        organizationId: params.organizationId,
        userId: params.userId,
        credentialId: definition.key,
        scope: "organization",
        value: params.value,
      });
    } catch (error) {
      // Without its key the credential cannot sign in; don't leave it behind.
      await deleteRuntimeCredentialDefinition({
        organizationId: params.organizationId,
        key: definition.key,
      }).catch(() => undefined);
      throw error;
    }
    return definition;
  }

  private config(flow: GithubAppSetupFlow) {
    const config = this.flows.get(flow);
    if (!config) throw new ApiError(400, "Unknown GitHub App setup");
    return config;
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

  private flows = new Map<GithubAppSetupFlow, GithubAppFlowConfig>();
}

export const githubAppManifestSetup = new GithubAppManifestSetup();

type GithubAppSetupFlow = "copilot";

interface GithubAppFlowConfig {
  /** Whether a personal account may own the App, or only an organization. */
  allowPersonal: boolean;
  /** Said when a personal account is given to a flow that needs an organization. */
  organizationRequired: string;
  /** Throws unless the user may run this flow. */
  authorize: (owner: Owner) => Promise<void>;
  manifest: (params: { appName: string; api: string }) => object;
}

export interface GithubAppInstallation {
  id: number;
  html_url?: string;
  account: { login: string; id: number; type?: string } | null;
  permissions?: Record<string, string>;
  repository_selection?: "all" | "selected";
}

/** The created App as an install step uses it, with its decrypted keys. */
type PendingGithubAppDetails = Omit<StoredPendingApp, "secret"> & {
  secret: { privateKey: string; clientSecret: string };
};

/** The account a person typed, or the reason it names none. */
export function parseAccount(input: string) {
  const account = parseGithubAccountInput(input);
  if (!account) throw new ApiError(400, GITHUB_ACCOUNT_INPUT_INVALID);
  // The setup reads GitHub from the server: only a GitHub over https.
  if (!account.web.startsWith("https://"))
    throw new ApiError(400, GITHUB_HTTPS_REQUIRED);
  return account;
}

/** What to say when a GitHub address is not https. */
const GITHUB_HTTPS_REQUIRED = "Use an https:// address for GitHub.";

/** The GitHub account behind a login, from GitHub's public profile. */
export async function lookupAccount(params: { api: string; login: string }) {
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
  if (response.status === 404) {
    const managed = await isManagedUsersOrganization(params);
    if (managed === null)
      throw new ApiError(502, `GitHub didn't return the ${login} account.`);
    if (managed) return { login, type: "Organization" as const };
    throw new ApiError(400, `GitHub has no account named ${login}.`);
  }
  const account = response.ok
    ? AccountSchema.safeParse(await response.json())
    : null;
  if (!account?.success)
    throw new ApiError(502, `GitHub didn't return the ${login} account.`);
  return account.data;
}

export function isAppGone(error: unknown) {
  return (
    error instanceof ApiError && error.internalCode === GITHUB_APP_NOT_FOUND
  );
}

// ===================== Internals =====================

type Owner = { organizationId: string; userId: string };

const START_TTL_MS = 30 * 60_000;
// GitHub's manifest code lives an hour; installing usually follows within minutes.
const PENDING_TTL_MS = 60 * 60_000;

const FlowSchema = z.enum(["copilot"]);
const StartFlowSchema = z.object({
  flow: FlowSchema,
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
  flow: FlowSchema,
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
const AccountSchema = z.object({
  login: z.string(),
  type: z.enum(["User", "Organization"]),
});

/**
 * Whether a login the API calls missing is an organization of an Enterprise
 * Managed Users enterprise. GitHub hides those from anonymous API reads, but
 * their web profile sends visitors to the enterprise's single sign-on, while
 * a missing account's profile is a 404. Null when GitHub didn't answer.
 */
async function isManagedUsersOrganization(params: {
  api: string;
  login: string;
}): Promise<boolean | null> {
  const web = getGithubWebOrigin(params.api);
  const response = await fetch(`${web}/${encodeURIComponent(params.login)}`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    logger.warn(
      { err: error, web },
      "GitHub web profile check for a hidden organization failed",
    );
    return null;
  });
  if (!response) return null;
  // A rate limit or server error says nothing about the account.
  if (response.status === 429 || response.status >= 500) {
    logger.warn(
      { status: response.status, web },
      "GitHub web profile check for a hidden organization failed",
    );
    return null;
  }
  const location = response.headers.get("location");
  if (response.status < 300 || response.status > 399 || !location) return false;
  const target = URL.canParse(location, web) ? new URL(location, web) : null;
  return (
    target?.origin === new URL(web).origin &&
    /^\/enterprises\/[^/]+\/sso\/?$/.test(target.pathname)
  );
}

function toPublic(pending: StoredPendingApp): PendingGithubApp {
  const installUrl = new URL(
    `${pending.htmlUrl.replace(/\/+$/, "")}/installations/new/permissions`,
  );
  installUrl.searchParams.set("target_id", String(pending.accountId));
  return {
    name: pending.name,
    slug: pending.slug,
    account: pending.account,
    appId: pending.appId,
    accountUrl: `${pending.web}/${pending.account}`,
    htmlUrl: pending.htmlUrl,
    // GitHub's own App page: /apps/<slug> on github.com, /github-apps/<slug> on Enterprise Server.
    installUrl: installUrl.toString(),
    settingsUrl:
      pending.accountType === "Organization"
        ? `${pending.web}/organizations/${encodeURIComponent(pending.account)}/settings/apps/${encodeURIComponent(pending.slug)}`
        : `${pending.web}/settings/apps/${encodeURIComponent(pending.slug)}`,
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function flowIdentifier(owner: Owner, step: "start" | "pending") {
  return `github-app-setup:${step}:${JSON.stringify([owner.organizationId, owner.userId])}`;
}

async function freeKey(organizationId: string, slug: string) {
  const base = `github-app-${slug}`.slice(0, 120);
  for (let suffix = 0; suffix < 100; suffix++) {
    const key = suffix ? `${base}-${suffix + 1}` : base;
    if (!(await RuntimeCredentialDefinitionModel.find({ organizationId, key })))
      return key;
  }
  throw new ApiError(409, "Too many credentials share this App's name");
}
