import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  AppModel,
  AppToolModel,
  AuditLogModel,
  InternalMcpCatalogModel,
  McpServerModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import appRoutes from "./app.routes";

describe("POST /api/apps/:id/transfer-ownership", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let recipient: User;
  let organizationId: string;
  let create: (ownerId?: string, name?: string) => Promise<{ id: string }>;
  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeApp }) => {
    config.plugins.enabled = true;
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    recipient = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    await makeMember(recipient.id, organizationId, { role: ADMIN_ROLE_NAME });
    create = async (ownerId = user.id, name = "handoff-resource") => {
      return makeApp({
        organizationId,
        authorId: ownerId,
        name,
        scope: "personal",
      });
    };
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(appRoutes);
  });
  afterEach(async () => {
    await app.close();
  });
  const transfer = (id: string, ownerId = recipient.id) =>
    app.inject({
      method: "POST",
      url: `/api/apps/${id}/transfer-ownership`,
      payload: { ownerId },
    });
  const snapshot = (id: string) =>
    AppModel.findByIdForAudit(id, organizationId);

  test("transfers and transfers back, preserving configuration and recording both owners", async () => {
    const resource = await create();
    const originalOwner = user;
    const before = await snapshot(resource.id);
    expect((await transfer(resource.id)).statusCode).toBe(200);
    const after = await snapshot(resource.id);
    expect(after).toMatchObject({ authorId: recipient.id });
    const logs = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: resource.id,
      action: "app.updated",
      limit: 10,
      offset: 0,
    });
    expect(logs.data).toHaveLength(1);
    expect(logs.data[0].before).toMatchObject({ authorId: originalOwner.id });
    expect(logs.data[0].after).toMatchObject({ authorId: recipient.id });
    const unchanged = (snapshot: Record<string, unknown> | null) =>
      Object.fromEntries(
        Object.entries(snapshot ?? {}).filter(
          ([key]) =>
            ![
              "authorId",
              "userId",
              "updatedAt",
              "createdByServiceAccountId",
              "createdBy",
              "authorName",
            ].includes(key),
        ),
      );
    expect(unchanged(after)).toEqual(unchanged(before));
    user = recipient;
    expect((await transfer(resource.id, originalOwner.id)).statusCode).toBe(
      200,
    );
    expect(await snapshot(resource.id)).toMatchObject({
      authorId: originalOwner.id,
    });
  });

  test("rejects non-owners without resource admin permission", async ({
    makeUser,
    makeMember,
  }) => {
    const resource = await create();
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
    expect((await transfer(resource.id)).statusCode).toBe(403);
  });

  test("rejects nonmembers, service accounts, and unchanged ownership without audit changes", async () => {
    const resource = await create();
    for (const ownerId of [
      "unknown",
      "service-account:00000000-0000-4000-8000-000000000000",
      user.id,
    ])
      expect((await transfer(resource.id, ownerId)).statusCode).toBe(400);
    expect(await snapshot(resource.id)).toMatchObject({ authorId: user.id });
    const logs = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: resource.id,
      limit: 10,
      offset: 0,
    });
    expect(logs.data).toHaveLength(0);
  });

  test("does not transfer a resource from another organization", async ({
    makeOrganization,
  }) => {
    const resource = await create();
    organizationId = (await makeOrganization()).id;
    expect((await transfer(resource.id)).statusCode).toBe(403);
  });

  test("rejects an unknown resource", async () => {
    expect((await transfer(crypto.randomUUID())).statusCode).toBe(404);
  });
  test("rejects a stale ownership snapshot", async () => {
    const resource = await create();
    const before = await snapshot(resource.id);
    expect((await transfer(resource.id)).statusCode).toBe(200);
    expect(
      await AppModel.transferOwnership({
        id: resource.id,
        organizationId,
        previousOwnerId: user.id,
        updatedAt: new Date(before?.updatedAt as string | Date),
        ownerId: user.id,
      }),
    ).toBe(false);
    expect(await snapshot(resource.id)).toMatchObject({
      authorId: recipient.id,
    });
  });

  test("a personal owner can hand off and loses ownership rights", async ({
    makeUser,
    makeMember,
  }) => {
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
    const resource = await create();
    expect((await transfer(resource.id)).statusCode).toBe(200);
    expect((await transfer(resource.id, user.id)).statusCode).toBe(403);
  });

  test("rejects a recipient name collision without changing the resource", async () => {
    const resource = await create();
    await create(recipient.id);
    const before = await snapshot(resource.id);
    expect((await transfer(resource.id)).statusCode).toBe(409);
    expect(await snapshot(resource.id)).toEqual(before);
  });

  test("transfers the app's backing catalog and connection together", async () => {
    const resource = await create();
    const before = await AppModel.findById(resource.id);
    expect((await transfer(resource.id)).statusCode).toBe(200);
    const appRow = await AppModel.findById(resource.id);
    expect(appRow).toMatchObject({
      authorId: recipient.id,
      slug: before?.slug,
      latestVersion: before?.latestVersion,
      mcpServerId: before?.mcpServerId,
    });
    const server = await McpServerModel.findById(appRow?.mcpServerId ?? "");
    expect(server).toMatchObject({ ownerId: recipient.id });
    expect(
      await InternalMcpCatalogModel.findById(server?.catalogId ?? "", {
        expandSecrets: false,
      }),
    ).toMatchObject({ authorId: recipient.id });
  });

  test("refuses a handoff that breaks a pinned team connection", async ({
    makeTeam,
    makeTeamMember,
    makeMcpServer,
    makeTool,
    makeUser,
    makeMember,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId, { role: MEMBER_ROLE_NAME });
    const next = await makeUser();
    await makeMember(next.id, organizationId, { role: MEMBER_ROLE_NAME });
    const team = await makeTeam(organizationId, owner.id);
    await makeTeamMember(team.id, owner.id);
    const server = await makeMcpServer({ scope: "team", teamId: team.id });
    const tool = await makeTool({
      name: "report-tool",
      catalogId: server.catalogId,
    });
    const resource = await create(owner.id);
    await AppToolModel.create(resource.id, tool.id, {
      mcpServerId: server.id,
      credentialResolutionMode: "static",
    });
    user = owner;
    expect((await transfer(resource.id, next.id)).statusCode).toBe(400);
    expect(await snapshot(resource.id)).toMatchObject({ authorId: owner.id });
  });
});
