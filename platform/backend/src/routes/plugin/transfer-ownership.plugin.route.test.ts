import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AuditLogModel, PluginModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import pluginRoutes from "./plugin.routes";

describe("POST /api/plugins/:id/transfer-ownership", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let recipient: User;
  let organizationId: string;
  let create: (ownerId?: string, name?: string) => Promise<{ id: string }>;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.plugins.enabled = true;
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    recipient = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    await makeMember(recipient.id, organizationId, { role: ADMIN_ROLE_NAME });
    create = async (ownerId = user.id, name = "handoff-resource") => {
      const row = await PluginModel.create({
        organizationId,
        userId: ownerId,
        input: {
          displayName: name,
          description: "Test handoff",
          clientType: "claude-code",
          files: [
            {
              path: "README.md",
              content: "Report instructions",
              encoding: "utf8",
              mode: "100644",
            },
          ],
        },
      });
      if (!row) throw new Error("Missing plugin");
      return row;
    };
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(pluginRoutes);
  });
  afterEach(async () => {
    await app.close();
  });
  const transfer = (id: string, ownerId = recipient.id) =>
    app.inject({
      method: "POST",
      url: `/api/plugins/${id}/transfer-ownership`,
      payload: { ownerId },
    });
  const snapshot = (id: string) =>
    PluginModel.findByIdForAudit(id, organizationId);

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
      action: "plugin.updated",
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
      await PluginModel.transferOwnership({
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
});
