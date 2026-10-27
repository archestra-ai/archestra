import { generateKeyPairSync } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { LlmProviderApiKeyModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
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
    if (url.endsWith("/users/acme"))
      return Response.json({
        login: "acme",
        type: options.accountType ?? "Organization",
      });
    if (url.includes("/app-manifests/"))
      return Response.json({
        id: Number(options.appId),
        slug: "archestra-copilot",
        name: "Archestra Copilot",
        pem: privateKey,
        html_url: "https://github.com/apps/archestra-copilot",
        owner: { login: "acme", id: 99, type: "Organization" },
      });
    if (url.endsWith("/app/installations"))
      return Response.json(
        options.installed === false
          ? []
          : [
              {
                id: 555,
                account: { login: "acme", id: 99 },
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
    if (url.endsWith("/app")) return Response.json({ id: options.appId });
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
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, payload });

  async function createAppFromManifest() {
    const started = await post("/api/github-copilot-app/manifest", {
      organization: "acme",
    });
    expect(started.statusCode, started.body).toBe(200);
    const state = new URL(started.json().url).searchParams.get("state");
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
      `https://github.com/organizations/acme/settings/apps/new?state=${new URL(started.url).searchParams.get("state")}`,
    );
    expect(JSON.parse(started.manifest)).toMatchObject({
      public: false,
      default_permissions: { organization_copilot_requests: "read" },
      default_events: [],
    });
    expect(JSON.parse(started.manifest).redirect_url).toMatch(
      /\/github\/copilot-app-setup$/,
    );
    expect(pending).toMatchObject({ organization: "acme", appId });

    const installed = await post("/api/github-copilot-app/install");
    expect(installed.statusCode, installed.body).toBe(200);
    const result = installed.json();
    expect(result).toMatchObject({
      status: "installed",
      organization: "acme",
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
    expect(stored.startsWith("github-app:")).toBe(true);

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

  test("refuses a personal GitHub account", async () => {
    vi.stubGlobal("fetch", githubFake({ appId, accountType: "User" }));

    const response = await post("/api/github-copilot-app/manifest", {
      organization: "acme",
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
      "acme doesn't allow Copilot requests from GitHub Apps",
    );
    expect(
      await LlmProviderApiKeyModel.findByOrganizationId(organizationId),
    ).toEqual([]);
  });

  test("validates an existing App by fingerprint without echoing its key", async () => {
    vi.stubGlobal("fetch", githubFake({ appId }));

    const response = await post("/api/github-copilot-app/existing/validate", {
      appId,
      organization: "ACME",
      privateKey,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]+=*$/),
      installationId: "555",
      organization: "acme",
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
      organization: "acme",
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
});
