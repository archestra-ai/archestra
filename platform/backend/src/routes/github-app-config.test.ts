import {
  type Action,
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  type Resource,
} from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { userHasPermission } from "@/auth/utils";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import GithubAppConfigModel from "@/models/github-app-config";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8",
  "-----END PRIVATE KEY-----",
].join("\n");

// real RBAC: the hook enforces the endpoint permission map against the
// user's DB-backed role rather than mocking the permission check
async function buildApp(user: User, organizationId: string) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: unknown }).user = user;
    (request as typeof request & { organizationId: string }).organizationId =
      organizationId;

    const routeId = request.routeOptions.schema?.operationId;
    const required = routeId
      ? requiredEndpointPermissionsMap[
          routeId as keyof typeof requiredEndpointPermissionsMap
        ]
      : undefined;
    if (!required) return;
    for (const [resource, actions] of Object.entries(required)) {
      for (const action of (actions ?? []) as Action[]) {
        const allowed = await userHasPermission(
          user.id,
          organizationId,
          resource as Resource,
          action,
        );
        if (!allowed) throw new ApiError(403, "Forbidden");
      }
    }
  });
  registerAuditLogHook(app);

  const { default: githubAppConfigRoutes } = await import(
    "./github-app-config"
  );
  await app.register(githubAppConfigRoutes);
  return app;
}

async function settleAuditWrites() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("github app config routes", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("create, list, get, rotate key, and delete — never exposing the PEM", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user, organization.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/github-app-configs",
      payload: {
        name: "Primary app",
        appId: "12345",
        installationId: "67890",
        privateKey: PEM,
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json();
    expect(createdBody).toMatchObject({
      name: "Primary app",
      appId: "12345",
      installationId: "67890",
      githubUrl: "https://api.github.com",
    });
    // the PEM and its secret reference must never leave the API
    expect(createdBody.privateKey).toBeUndefined();
    expect(createdBody.secretId).toBeUndefined();

    // the PEM is persisted in the secret store, not the config row
    const stored = await GithubAppConfigModel.findByIdForOrganization({
      id: createdBody.id,
      organizationId: organization.id,
    });
    const secretId = stored?.secretId;
    if (!secretId) throw new Error("expected a stored secret id");
    const secret = await secretManager().getSecret(secretId);
    expect((secret?.secret as { apiToken?: string })?.apiToken).toBe(PEM);

    const listed = await app.inject({
      method: "GET",
      url: "/api/github-app-configs",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0].secretId).toBeUndefined();

    const fetched = await app.inject({
      method: "GET",
      url: `/api/github-app-configs/${createdBody.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().secretId).toBeUndefined();

    const rotatedPem = `${PEM}\n# rotated`;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/github-app-configs/${createdBody.id}`,
      payload: { name: "Renamed app", privateKey: rotatedPem },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe("Renamed app");

    const rotatedSecret = await secretManager().getSecret(secretId);
    expect((rotatedSecret?.secret as { apiToken?: string })?.apiToken).toBe(
      rotatedPem,
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/github-app-configs/${createdBody.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true });

    // the stored secret is removed along with the config
    expect(await secretManager().getSecret(secretId)).toBeNull();

    await settleAuditWrites();
    const { data: auditRows } = await AuditLogModel.findPaginated({
      organizationId: organization.id,
      resourceType: "githubAppConfig",
      sortDirection: "asc",
      limit: 50,
      offset: 0,
    });
    expect(auditRows.map((row) => row.action)).toEqual([
      "githubAppConfig.created",
      "githubAppConfig.updated",
      "githubAppConfig.deleted",
    ]);
  });

  test("rejects a non-HTTP githubUrl", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user, organization.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/github-app-configs",
      payload: {
        name: "Bad URL app",
        githubUrl: "ftp://github.example.com",
        appId: "12345",
        installationId: "67890",
        privateKey: PEM,
      },
    });
    expect(created.statusCode).toBe(400);
  });

  test("default members cannot manage GitHub App configs", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: MEMBER_ROLE_NAME });
    app = await buildApp(user, organization.id);

    const listed = await app.inject({
      method: "GET",
      url: "/api/github-app-configs",
    });
    expect(listed.statusCode).toBe(403);
  });

  test("cannot delete a config that connectors still reference", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user, organization.id);

    const secret = await secretManager().createSecret(
      { apiToken: PEM },
      "in-use-app",
    );
    const config = await GithubAppConfigModel.create({
      organizationId: organization.id,
      name: "In use",
      appId: "1",
      installationId: "1",
      secretId: secret.id,
    });
    await KnowledgeBaseConnectorModel.create({
      organizationId: organization.id,
      name: "uses-app",
      connectorType: "github",
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "test-org",
        authMethod: "github_app",
        githubAppConfigId: config.id,
      },
      secretId: null,
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/github-app-configs/${config.id}`,
    });
    expect(deleted.statusCode).toBe(409);

    // the config and its secret survive the rejected deletion
    expect(
      await GithubAppConfigModel.findByIdForOrganization({
        id: config.id,
        organizationId: organization.id,
      }),
    ).not.toBeNull();
    expect(await secretManager().getSecret(secret.id)).not.toBeNull();
  });

  test("deletes a config that only a switched-to-PAT connector still references", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user, organization.id);

    const secret = await secretManager().createSecret(
      { apiToken: PEM },
      "stale-app",
    );
    const config = await GithubAppConfigModel.create({
      organizationId: organization.id,
      name: "Stale",
      appId: "1",
      installationId: "1",
      secretId: secret.id,
    });
    // a connector that switched to PAT but kept a stale githubAppConfigId in its
    // JSON must not block deletion, since it no longer authenticates via the App
    const patSecret = await secretManager().createSecret(
      { apiToken: "ghp_token" },
      "switched-pat",
    );
    await KnowledgeBaseConnectorModel.create({
      organizationId: organization.id,
      name: "switched-to-pat",
      connectorType: "github",
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "test-org",
        authMethod: "pat",
        githubAppConfigId: config.id,
      },
      secretId: patSecret.id,
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/github-app-configs/${config.id}`,
    });
    expect(deleted.statusCode).toBe(200);
  });

  test("cannot access another organization's config", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    await makeMember(user.id, orgB.id, { role: ADMIN_ROLE_NAME });

    const config = await GithubAppConfigModel.create({
      organizationId: orgA.id,
      name: "A",
      appId: "1",
      installationId: "1",
    });

    app = await buildApp(user, orgB.id);
    const fetched = await app.inject({
      method: "GET",
      url: `/api/github-app-configs/${config.id}`,
    });
    expect(fetched.statusCode).toBe(404);
  });
});
