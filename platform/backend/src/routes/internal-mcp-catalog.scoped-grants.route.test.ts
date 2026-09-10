// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import routes from "./internal-mcp-catalog";

describe("catalog object grants", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(
    async ({ makeOrganization, makeUser, makeMember, makeCustomRole }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      user = await makeUser();
      const role = await makeCustomRole(org.id, { permission: {} });
      await makeMember(user.id, org.id, { role: role.role });
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.user = user;
        request.organizationId = organizationId;
      });
      registerAuditLogHook(app);
      await app.register(routes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("catalog grants cannot change a linked app's visibility", async ({
    makeApp,
    makeUser,
  }) => {
    const owner = await makeUser();
    const ownedApp = await makeApp({
      organizationId,
      authorId: owner.id,
      scope: "personal",
      enabled: true,
    });
    if (!ownedApp.mcpServerId) throw new Error("Missing app backing server");
    const server = await McpServerModel.findById(ownedApp.mcpServerId);
    const catalogId = server?.catalogId;
    if (!catalogId) throw new Error("Missing app backing catalog");
    await replacePolicy({
      organizationId,
      resource: "mcpRegistry",
      scope: catalogId,
      revision: 0,
      grants: [
        {
          subject: { type: "user", id: user.id },
          actions: ["read", "update", "manage-permissions"],
        },
      ],
    });
    const denied = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: { scope: "org" },
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await InternalMcpCatalogModel.findById(catalogId))?.scope).toBe(
      "personal",
    );
  });

  test("an exact update grant permits a metadata edit and audit, but not deletion or another object", async ({
    makeUser,
  }) => {
    const author = await makeUser();
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "scoped-edit",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "personal",
      },
      { organizationId, authorId: author.id },
    );
    const other = await InternalMcpCatalogModel.create(
      {
        name: "other-private",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "personal",
      },
      { organizationId, authorId: author.id },
    );
    const key = {
      organizationId,
      resource: "mcpRegistry" as const,
      scope: catalog.id,
    };
    await replacePolicy({
      ...key,
      revision: 0,
      grants: [
        { subject: { type: "user", id: user.id }, actions: ["read", "update"] },
      ],
    });
    const formerlyOrgVisible = await InternalMcpCatalogModel.create(
      {
        name: "org-visible-without-grant",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      },
      { organizationId, authorId: author.id },
    );
    await replacePolicy({
      organizationId: organizationId,
      resource: "mcpRegistry",
      scope: formerlyOrgVisible.id,
      revision: 0,
      grants: [],
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().map((item: { id: string }) => item.id)).toEqual([
      catalog.id,
    ]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/internal_mcp_catalog/${catalog.id}`,
        })
      ).statusCode,
    ).toBe(200);
    const edited = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "Updated through a scoped grant" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.description,
    ).toBe("Updated through a scoped grant");
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 10,
      offset: 0,
      resourceId: catalog.id,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            description: "Updated through a scoped grant",
          }),
        }),
      ]),
    );
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/internal_mcp_catalog/${catalog.id}`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/internal_mcp_catalog/${other.id}`,
          payload: { description: "Forbidden" },
        })
      ).statusCode,
    ).toBe(404);
    await replacePolicy({
      ...key,
      revision: 1,
      grants: [{ subject: { type: "user", id: user.id }, actions: ["read"] }],
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/internal_mcp_catalog/${catalog.id}`,
          payload: { description: "Forbidden after revocation" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.description,
    ).toBe("Updated through a scoped grant");
  });

  test("creation persists initial service-account grants and includes them in the audit record", async () => {
    await MemberModel.updateRole(user.id, organizationId, "admin");
    const account = await ServiceAccountModel.create({
      organizationId,
      name: "Build account",
      role: "member",
      createdBy: user.id,
    });
    const grants = [
      {
        subject: { type: "serviceAccount" as const, id: account.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const created = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        ...{
          name: "created-with-grants",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          scope: "personal",
        },
        initialGrants: grants,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId,
          resource: "mcpRegistry",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      {
        subject: { type: "user", id: user.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 10,
      offset: 0,
      resourceId: id,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            resourcePermissions: [
              ...grants,
              {
                subject: { type: "user", id: user.id },
                actions: [
                  "read",
                  "use",
                  "update",
                  "delete",
                  "manage-permissions",
                ],
              },
            ],
          }),
        }),
      ]),
    );
  });

  test("an invalid initial recipient rejects creation before the resource is inserted", async () => {
    await MemberModel.updateRole(user.id, organizationId, "admin");
    const before = await InternalMcpCatalogModel.findAll();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        ...{
          name: "created-with-grants",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          scope: "personal",
        },
        initialGrants: [
          {
            subject: { type: "user", id: "missing-recipient" },
            actions: ["read"],
          },
        ],
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(400);
    const after = await InternalMcpCatalogModel.findAll();
    expect(after.map((item) => item.id).sort()).toEqual(
      before.map((item) => item.id).sort(),
    );
  });
});

async function replacePolicy(
  params: Parameters<typeof ResourcePermissionPolicyModel.replace>[0],
) {
  const policy = await ResourcePermissionPolicyModel.find(params);
  const updated = await ResourcePermissionPolicyModel.replace({
    ...params,
    revision: policy?.revision ?? 0,
  });
  expect(updated).not.toBeNull();
  return updated;
}
