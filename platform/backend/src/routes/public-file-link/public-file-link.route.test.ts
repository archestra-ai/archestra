import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { OrganizationModel, PublicFileLinkModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import { publicFileSharing } from "@/public-files/public-file-sharing";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";
import publicFileLinkRoutes from "./public-file-link.routes";
import publicFilesRoutes from "./public-files.routes";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("public file link admin routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let member: User;
  let linkId: string;
  let publicPath: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    config.publicFiles.baseUrl = "https://files.example.com";
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    member = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });
    await OrganizationModel.patch(organizationId, {
      allowPublicFileSharing: true,
    });
    const agent = await makeAgent({ organizationId, name: "Social Agent" });
    const file = await fileStore.put({
      organizationId,
      userId: member.id,
      projectId: null,
      conversationId: null,
      filename: "post.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      data: PNG,
    });
    const shared = await publicFileSharing.share({
      organizationId,
      userId: member.id,
      agentId: agent.id,
      conversationId: null,
      file: { id: file.id, filename: file.filename, data: PNG },
    });
    if ("error" in shared) throw new Error(shared.message);
    linkId = shared.link.id;
    publicPath = new URL(shared.url).pathname;

    app = createFastifyInstance();
    await app.register(authPlugin);
    registerAuditLogHook(app);
    await app.register(publicFileLinkRoutes);
    await app.register(publicFilesRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function actAs(user: User) {
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
      response: {
        user: { id: user.id },
        session: { activeOrganizationId: organizationId },
      },
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof betterAuth.api.getSession>>);
  }

  test("an admin lists links with who shared them, through which agent, and the full URL", async () => {
    actAs(admin);
    const response = await app.inject({
      method: "GET",
      url: "/api/public-file-links?limit=10&offset=0",
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.pagination).toMatchObject({ total: 1 });
    expect(body.data).toEqual([
      expect.objectContaining({
        id: linkId,
        filename: "post.png",
        url: `https://files.example.com${publicPath}`,
        createdBy: expect.objectContaining({ id: member.id }),
        agent: expect.objectContaining({ name: "Social Agent" }),
        revokedAt: null,
      }),
    ]);
  });

  test("members can neither list nor revoke links", async () => {
    actAs(member);
    const list = await app.inject({
      method: "GET",
      url: "/api/public-file-links",
    });
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/public-file-links/${linkId}`,
    });

    expect(list.statusCode).toBe(403);
    expect(revoke.statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: publicPath })).statusCode,
    ).toBe(200);
  });

  test("revoking takes the link down and writes an audit record", async () => {
    actAs(admin);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/public-file-links/${linkId}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: publicPath })).statusCode,
    ).toBe(404);
    await vi.waitFor(async () => {
      const audit = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "publicFileLink",
        limit: 10,
        offset: 0,
      });
      expect(audit.data).toEqual([
        expect.objectContaining({
          action: "publicFileLink.revoked",
          resourceId: linkId,
          actorId: admin.id,
          before: expect.objectContaining({ revokedAt: null }),
          after: expect.objectContaining({ revokedAt: expect.anything() }),
        }),
      ]);
    });
  });

  test("a link in another organization is not found", async ({
    makeOrganization,
    makeUser,
  }) => {
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    const otherFile = await fileStore.put({
      organizationId: otherOrg.id,
      userId: otherUser.id,
      projectId: null,
      conversationId: null,
      filename: "other.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      data: PNG,
    });
    const foreign = await PublicFileLinkModel.create({
      organizationId: otherOrg.id,
      token: "B".repeat(32),
      fileId: otherFile.id,
      createdByUserId: otherUser.id,
      agentId: null,
      conversationId: null,
      filename: "other.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
    });

    actAs(admin);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/public-file-links/${foreign.id}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
