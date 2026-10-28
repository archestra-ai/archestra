import { generateKeyPairSync } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  LlmProviderApiKeyModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { getRuntimeCredentialUsage } from "@/services/agent-runtime/runtime-credentials";
import {
  decodeGithubAppReference,
  encodeGithubAppCredential,
} from "@/services/github-app-copilot-token";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Each test gets its own App so the shared installation-token cache never leaks. */
let appCounter = 7000;

/**
 * GitHub is the process boundary: a router answering only the calls the
 * setup makes, configurable per test.
 */
function githubFake(options: {
  appId: string;
  accountType?: "Organization" | "User";
  installed?: boolean;
  permissions?: Record<string, string>;
  copilotModels?: Response;
}) {
  return vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/users/my-org"))
      return Response.json({
        login: "my-org",
        type: options.accountType ?? "Organization",
      });
    if (url.includes("/app-manifests/"))
      return Response.json({
        id: Number(options.appId),
        slug: "my-org-copilot",
        name: "My Org Copilot",
        pem: privateKey,
        client_id: "Iv1.client",
        client_secret: "client-secret",
        html_url: "https://github.com/apps/my-org-copilot",
        owner: { login: "my-org", id: 99, type: "Organization" },
      });
    if (url.endsWith("/app/installations"))
      return Response.json(
        options.installed === false
          ? []
          : [
              {
                id: 555,
                account: { login: "my-org", id: 99 },
                permissions: options.permissions ?? {
                  organization_copilot_requests: "read",
                },
              },
            ],
      );
    if (url.endsWith("/access_tokens"))
      return Response.json(
        {
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
        { status: 201 },
      );
    if (url.endsWith("/app"))
      return Response.json({
        id: options.appId,
        name: "My Org Copilot",
        slug: "my-org-copilot",
        html_url: "https://github.com/apps/my-org-copilot",
        owner: { login: "my-org", type: "Organization" },
      });
    if (url.endsWith("api.githubcopilot.com/models"))
      return (
        options.copilotModels?.clone() ??
        Response.json({
          data: [
            { id: "gpt-4o", capabilities: { type: "chat" } },
            { id: "claude-sonnet-4", capabilities: { type: "chat" } },
          ],
        })
      );
    // Invocability probes answer with a payload complaint: model accepted.
    if (url.includes("api.githubcopilot.com"))
      return Response.json(
        { error: { message: "messages must be non-empty" } },
        { status: 400 },
      );
    // models.dev enrichment and anything else: nothing to add.
    return Response.json({});
  });
}

describe("GitHub Copilot organization subscription setup", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let appId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    appCounter += 1;
    appId = String(appCounter);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    const { default: routes } = await import("./github-copilot-app.routes");
    await app.register(routes);
    const { default: keyRoutes } = await import("../llm-provider-api-keys");
    await app.register(keyRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, payload });

  async function createAppFromManifest() {
    const started = await post("/api/github-copilot-app/manifest", {
      organization: "my-org",
    });
    expect(started.statusCode, started.body).toBe(200);
    const state = new URL(started.json().url).searchParams.get("state");
    // Model Providers' return page completes the setup.
    const completed = await post("/api/github-copilot-app/manifest/complete", {
      code: "one-time-code",
      state,
    });
    expect(completed.statusCode, completed.body).toBe(200);
    return { started: started.json(), pending: completed.json() };
  }

  test("registers, installs and stores the App as a shared key, audited without its key", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));

    const { started, pending } = await createAppFromManifest();
    expect(started.url).toBe(
      `https://github.com/organizations/my-org/settings/apps/new?state=${new URL(started.url).searchParams.get("state")}`,
    );
    expect(JSON.parse(started.manifest)).toMatchObject({
      public: false,
      default_permissions: { organization_copilot_requests: "read" },
      default_events: [],
    });
    expect(JSON.parse(started.manifest).redirect_url).toMatch(
      /\/llm\/model-providers\/github-app$/,
    );
    expect(pending).toMatchObject({ account: "my-org", appId });

    const installed = await post("/api/github-copilot-app/install");
    expect(installed.statusCode, installed.body).toBe(200);
    const result = installed.json();
    expect(result).toMatchObject({
      status: "installed",
      organization: "my-org",
    });
    expect(result.modelIds).toEqual(
      expect.arrayContaining(["claude-sonnet-4", "gpt-4o"]),
    );
    expect(installed.body).not.toContain("PRIVATE KEY");

    const key = await LlmProviderApiKeyModel.findById(result.id);
    expect(key).toMatchObject({
      provider: "github-copilot",
      userId: null,
      scope: "org",
    });
    expect(await LlmProviderApiKeyModel.isGithubAppKey(result.id)).toBe(true);
    const stored = (await getSecretValueForLlmProviderApiKey(
      key?.secretId ?? "",
    )) as string;
    // The key references the App's GitHub App credential, not a copy of its key.
    const reference = decodeGithubAppReference(stored);
    expect(reference).toMatchObject({
      organization: "my-org",
      installationId: "555",
    });
    const credential = await RuntimeCredentialDefinitionModel.findById({
      id: reference?.ref.credentialId ?? "",
      organizationId,
    });
    expect(credential).toMatchObject({
      kind: "github_app",
      name: "My Org Copilot",
      appId,
      installationId: "555",
    });

    const rows = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, organizationId),
          eq(schema.auditLogsTable.resourceId, result.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "llmProviderApiKey.created",
      resourceType: "llmProviderApiKey",
    });
    const audited = JSON.stringify(rows[0]);
    expect(audited).not.toContain("PRIVATE KEY");
    expect(audited).not.toContain("github-app:");
  });

  test("a new App made while reconnecting replaces the key's App instead of adding a key", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));
    const connected = await post("/api/github-copilot-app/existing", {
      appId,
      organization: "my-org",
      privateKey,
    });
    expect(connected.statusCode, connected.body).toBe(200);
    const keyId = connected.json().id;

    await createAppFromManifest();
    const installed = await post("/api/github-copilot-app/install", {
      replaceKeyId: keyId,
    });
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({ status: "installed", id: keyId });

    const keys = await db
      .select({ id: schema.llmProviderApiKeysTable.id })
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, "github-copilot"),
        ),
      );
    expect(keys).toEqual([{ id: keyId }]);
  });

  test("names a new key as asked; replacing its App keeps that name", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));
    const connected = await post("/api/github-copilot-app/existing", {
      appId,
      organization: "my-org",
      privateKey,
      name: "Copilot for my-org",
    });
    expect(connected.statusCode, connected.body).toBe(200);
    const keyId = connected.json().id;
    expect((await LlmProviderApiKeyModel.findById(keyId))?.name).toBe(
      "Copilot for my-org",
    );

    const replaced = await post("/api/github-copilot-app/existing", {
      appId,
      privateKey,
      replaceKeyId: keyId,
      name: "Ignored",
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect((await LlmProviderApiKeyModel.findById(keyId))?.name).toBe(
      "Copilot for my-org",
    );
  });

  test("takes the organization's address instead of its name", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));

    const fromUrl = await post("/api/github-copilot-app/manifest", {
      organization: "https://github.com/my-org/settings/copilot",
    });
    expect(fromUrl.statusCode, fromUrl.body).toBe(200);
    expect(fromUrl.json().url).toMatch(
      /^https:\/\/github\.com\/organizations\/my-org\/settings\/apps\/new\?state=/,
    );

    const garbage = await post("/api/github-copilot-app/manifest", {
      organization: "not an org",
    });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().error.message).toBe(
      "Enter an organization name or its GitHub address.",
    );
  });

  test("checks the organization before the existing-App step", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));
    const ok = await post("/api/github-copilot-app/organization/check", {
      organization: "https://github.com/my-org/",
    });
    expect(ok.json()).toEqual({ organization: "my-org" });

    const empty = await post("/api/github-copilot-app/organization/check", {
      organization: "",
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toBe(
      "Enter an organization name or its GitHub address.",
    );

    vi.stubGlobal("fetch", githubFake({ appId, accountType: "User" }));
    const personal = await post("/api/github-copilot-app/organization/check", {
      organization: "my-org",
    });
    expect(personal.json().error.message).toBe(
      "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
    );
  });

  test("refuses a personal GitHub account", async () => {
    vi.stubGlobal("fetch", githubFake({ appId, accountType: "User" }));

    const response = await post("/api/github-copilot-app/manifest", {
      organization: "my-org",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "GitHub Copilot needs an organization on Copilot Business or Enterprise.",
    );
  });

  test("waits until the App is installed on the organization", async () => {
    vi.stubGlobal("fetch", githubFake({ appId, installed: false }));
    await createAppFromManifest();

    const response = await post("/api/github-copilot-app/install");

    expect(response.json()).toEqual({ status: "waiting" });
    expect(
      await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId)),
    ).toHaveLength(0);
  });

  test("explains a missing Copilot Requests permission and stores nothing", async () => {
    vi.stubGlobal(
      "fetch",
      githubFake({ appId, permissions: { metadata: "read" } }),
    );
    await createAppFromManifest();

    const response = await post("/api/github-copilot-app/install");

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "doesn't have the Copilot Requests permission",
    );
    expect(
      await LlmProviderApiKeyModel.findByOrganizationId(organizationId),
    ).toEqual([]);
    // No GitHub App credential is saved for an App that can't be used.
    expect(await RuntimeCredentialDefinitionModel.list(organizationId)).toEqual(
      [],
    );
  });

  test("quotes GitHub when the organization doesn't allow App requests", async () => {
    vi.stubGlobal(
      "fetch",
      githubFake({
        appId,
        copilotModels: Response.json(
          {
            message:
              "Copilot requests from GitHub App installations are not enabled for this organization",
          },
          { status: 403 },
        ),
      }),
    );
    await createAppFromManifest();

    const response = await post("/api/github-copilot-app/install");

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "my-org doesn't allow Copilot requests from GitHub Apps",
    );
    expect(
      await LlmProviderApiKeyModel.findByOrganizationId(organizationId),
    ).toEqual([]);
    // No GitHub App credential is saved for an App that can't be used.
    expect(await RuntimeCredentialDefinitionModel.list(organizationId)).toEqual(
      [],
    );
  });

  test("validates an existing App by fingerprint without echoing its key", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));

    const response = await post("/api/github-copilot-app/existing/validate", {
      appId,
      organization: "MY-ORG",
      privateKey,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]+=*$/),
      installationId: "555",
      organization: "my-org",
    });
    expect(response.body).not.toContain("PRIVATE KEY");
  });

  test("connects an existing App and keeps it apart from personal sign-ins", async ({
    makeUser,
    makeMember,
    makeSecret,
  }) => {
    vi.stubGlobal("fetch", githubFake({ appId }));
    const connected = await post("/api/github-copilot-app/existing", {
      appId,
      organization: "my-org",
      privateKey,
    });
    expect(connected.statusCode, connected.body).toBe(200);
    const appKeyId = connected.json().id;

    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    const resolve = (agentLlmApiKeyId?: string) =>
      LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId,
        userId: member.id,
        userTeamIds: [],
        provider: "github-copilot",
        conversationId: null,
        agentLlmApiKeyId,
      });

    // No personal sign-in: the App key never stands in.
    expect(await resolve()).toBeNull();
    // Named explicitly, the App key is used.
    expect((await resolve(appKeyId))?.id).toBe(appKeyId);

    const secret = await makeSecret({ secret: { apiKey: "gho_member" } });
    const personal = await LlmProviderApiKeyModel.create(
      {
        organizationId,
        name: "My Copilot",
        provider: "github-copilot",
        secretId: secret.id,
        scope: "personal",
        userId: member.id,
        isPrimary: true,
      },
      { apiKeyValue: "gho_member" },
    );
    // The personal path uses the personal sign-in, never the App key; a named
    // App key is still the App key.
    expect((await resolve())?.id).toBe(personal.id);
    expect((await resolve(appKeyId))?.id).toBe(appKeyId);
  });

  test("summarizes, replaces the private key, and needs a reconnect once GitHub refuses the App", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));
    const connected = await post("/api/github-copilot-app/existing", {
      appId,
      organization: "my-org",
      privateKey,
    });
    const keyId = connected.json().id;

    const summary = await app.inject({
      method: "GET",
      url: `/api/github-copilot-app/keys/${keyId}`,
    });
    expect(summary.json()).toEqual({
      organization: "my-org",
      appId,
      appName: "My Org Copilot",
      appIcon: "logo:github",
      appUrl: "https://github.com/apps/my-org-copilot",
      githubUrl: "https://github.com",
      fingerprint: expect.stringMatching(/^SHA256:/),
    });
    expect(summary.body).not.toContain("PRIVATE KEY");

    // GitHub no longer knows the installation: the key needs a reconnect.
    const key = await LlmProviderApiKeyModel.findById(keyId);
    const stored = (await getSecretValueForLlmProviderApiKey(
      key?.secretId ?? "",
    )) as string;
    // Uninstalled: Copilot refuses the cached token and minting a new one
    // finds no installation.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).endsWith("/access_tokens")
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );
    const refused = await createGithubCopilotFetch({
      githubToken: stored,
      providerApiKeyId: keyId,
    })("https://api.githubcopilot.com/models");
    expect(refused.status).toBe(401);
    expect(
      (await LlmProviderApiKeyModel.findById(keyId))?.requiresReauthentication,
    ).toBe(true);

    // A new private key that GitHub accepts clears it.
    vi.stubGlobal("fetch", githubFake({ appId }));
    const replaced = await post(
      `/api/github-copilot-app/keys/${keyId}/private-key`,
      { privateKey },
    );
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(
      (await LlmProviderApiKeyModel.findById(keyId))?.requiresReauthentication,
    ).toBe(false);
    const audit = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.resourceId, keyId),
          eq(schema.auditLogsTable.action, "llmProviderApiKey.updated"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("PRIVATE KEY");
  });

  /** A GitHub App credential already connected to the organization. */
  async function connectedApp(params?: { permissions?: string }) {
    vi.stubGlobal(
      "fetch",
      githubFake({
        appId,
        permissions: params?.permissions
          ? { [params.permissions]: "read" }
          : undefined,
      }),
    );
    const connected = await post("/api/github-copilot-app/existing", {
      appId,
      organization: "my-org",
      privateKey,
    });
    expect(connected.statusCode, connected.body).toBe(200);
    const key = await LlmProviderApiKeyModel.findById(connected.json().id);
    const reference = decodeGithubAppReference(
      (await getSecretValueForLlmProviderApiKey(key?.secretId ?? "")) as string,
    );
    return { keyId: connected.json().id as string, reference };
  }

  test("uses an App already connected to the organization, or says what it lacks", async () => {
    const { reference } = await connectedApp();
    const credentialId = reference?.ref.credentialId as string;

    // Its installation lacks Copilot Requests: say where to add it.
    vi.stubGlobal(
      "fetch",
      githubFake({ appId, permissions: { metadata: "read" } }),
    );
    const lacking = await post("/api/github-copilot-app/credential", {
      credentialId,
      organization: "my-org",
    });
    expect(lacking.json()).toEqual({
      status: "needs_permission",
      appName: expect.any(String),
      organization: "my-org",
      settingsUrl:
        "https://github.com/organizations/my-org/settings/apps/my-org-copilot",
    });

    vi.stubGlobal("fetch", githubFake({ appId }));
    const picked = await post("/api/github-copilot-app/credential", {
      credentialId,
      organization: "https://github.com/my-org",
    });
    expect(picked.json()).toMatchObject({
      status: "installed",
      organization: "my-org",
    });
    const pickedKey = await LlmProviderApiKeyModel.findById(picked.json().id);
    expect(
      decodeGithubAppReference(
        (await getSecretValueForLlmProviderApiKey(
          pickedKey?.secretId ?? "",
        )) as string,
      )?.ref.credentialId,
    ).toBe(credentialId);
  });

  test("disconnecting deletes only the key; the shared App credential stays", async () => {
    const { keyId, reference } = await connectedApp();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${keyId}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await LlmProviderApiKeyModel.findById(keyId)).toBeNull();
    expect(
      await RuntimeCredentialDefinitionModel.findById({
        id: reference?.ref.credentialId as string,
        organizationId,
      }),
    ).not.toBeNull();
  });

  test("blocks deleting a GitHub App credential a Copilot plan uses", async () => {
    const { reference } = await connectedApp();
    const definition = await RuntimeCredentialDefinitionModel.findById({
      id: reference?.ref.credentialId as string,
      organizationId,
    });

    const usage = await getRuntimeCredentialUsage({
      organizationId,
      key: definition?.key as string,
    });
    expect(usage.resources).toContainEqual({
      id: expect.any(String),
      name: "GitHub Copilot for my-org",
      kind: "copilot",
    });
    const { deleteRuntimeCredentialDefinition } = await import(
      "@/services/agent-runtime/runtime-credentials"
    );
    await expect(
      deleteRuntimeCredentialDefinition({
        organizationId,
        key: definition?.key as string,
      }),
    ).rejects.toThrow("Remove this credential from its resources");
  });

  test("needs a reconnect, not a server error, once its App credential is disconnected", async () => {
    const { keyId, reference } = await connectedApp();
    const definition = await RuntimeCredentialDefinitionModel.findById({
      id: reference?.ref.credentialId as string,
      organizationId,
    });
    await RuntimeCredentialConnectionModel.delete({
      organizationId,
      credentialId: definition?.key as string,
      scope: "organization",
    });
    // Past the short resolution cache.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    const key = await LlmProviderApiKeyModel.findById(keyId);
    const response = await createGithubCopilotFetch({
      githubToken: (await getSecretValueForLlmProviderApiKey(
        key?.secretId ?? "",
      )) as string,
      providerApiKeyId: keyId,
    })("https://api.githubcopilot.com/models");
    vi.useRealTimers();

    expect(response.status).toBe(401);
    expect(
      (await LlmProviderApiKeyModel.findById(keyId))?.requiresReauthentication,
    ).toBe(true);

    // Reconnect through the picker repoints the key and clears it.
    vi.stubGlobal("fetch", githubFake({ appId }));
    await setConnection(definition?.key as string);
    const reconnected = await post("/api/github-copilot-app/credential", {
      credentialId: definition?.id,
      replaceKeyId: keyId,
    });
    expect(reconnected.json()).toMatchObject({
      status: "installed",
      id: keyId,
    });
    expect(
      (await LlmProviderApiKeyModel.findById(keyId))?.requiresReauthentication,
    ).toBe(false);
  });

  test("reads models with the in-memory App value used before the App is saved", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));
    const response = await createGithubCopilotFetch({
      githubToken: encodeGithubAppCredential({
        appId,
        installationId: "555",
        privateKey,
      }),
    })("https://api.githubcopilot.com/models");
    expect(response.status).toBe(200);
  });

  async function setConnection(credentialKey: string) {
    const { setRuntimeCredentialConnection } = await import(
      "@/services/agent-runtime/runtime-credentials"
    );
    await setRuntimeCredentialConnection({
      organizationId,
      userId: user.id,
      credentialId: credentialKey,
      scope: "organization",
      value: privateKey,
    });
  }
});
