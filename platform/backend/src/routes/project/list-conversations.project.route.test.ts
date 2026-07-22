import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { ConversationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/** A project chat row as returned by GET /api/projects/:id/conversations. */
type ConversationItem = {
  id: string;
  authorUserId: string;
  readOnly: boolean;
};

function items(body: string): ConversationItem[] {
  return JSON.parse(body) as ConversationItem[];
}

function ids(body: string): string[] {
  return items(body)
    .map((c) => c.id)
    .sort();
}

/**
 * GET /api/projects/:id/conversations visibility of OTHER members' chats is
 * gated by `project:read-all`. Without it a caller sees only the chats they
 * authored — uniformly, including in a project they own (no ownership
 * exemption). Admin holds `read-all` by default; a custom role can be granted
 * it. Own chats are always visible.
 */
describe("GET /api/projects/:id/conversations (project:read-all)", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let agentId: string;
  let owner: User;
  let viewer: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser({ email: "owner@test.com" });
    await makeMember(owner.id, organizationId, {});
    viewer = await makeUser({ email: "viewer@test.com" });
    await makeMember(viewer.id, organizationId, {});
    agentId = (await makeAgent({ name: "Chat Agent", teams: [] })).id;
    actingUser = viewer;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  /** A shared project owned by `owner`, with a chat from `owner` and `viewer`. */
  async function seedProjectWithTwoChats() {
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "Shared Project",
      description: null,
    });
    await projectService.setShare({
      id: project.id,
      organizationId,
      userId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const ownerChat = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId,
      title: "owner chat",
      projectId: project.id,
    });
    const viewerChat = await ConversationModel.create({
      userId: viewer.id,
      organizationId,
      agentId,
      title: "viewer chat",
      projectId: project.id,
    });
    return { project, ownerChat, viewerChat };
  }

  const listConvos = (projectId: string) =>
    app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/conversations`,
    });

  test("a non-owner member without read-all sees only the chats they authored", async () => {
    const { project, viewerChat } = await seedProjectWithTwoChats();
    actingUser = viewer;

    const body = (await listConvos(project.id)).body;
    expect(ids(body)).toEqual([viewerChat.id]);
    // Their own chat is writable, never read-only.
    expect(items(body).find((c) => c.id === viewerChat.id)?.readOnly).toBe(
      false,
    );
  });

  test("the project owner without read-all is NOT exempt — sees only their own chats", async () => {
    const { project, ownerChat } = await seedProjectWithTwoChats();
    actingUser = owner;

    // Owner authored ownerChat but not viewerChat; without read-all the foreign
    // chat is hidden even though they own the project.
    expect(ids((await listConvos(project.id)).body)).toEqual([ownerChat.id]);
  });

  test("an admin sees every chat by default (read-all via the Admin role)", async ({
    makeUser,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const { project, ownerChat, viewerChat } = await seedProjectWithTwoChats();
    actingUser = admin;

    const body = (await listConvos(project.id)).body;
    expect(ids(body)).toEqual([ownerChat.id, viewerChat.id].sort());
    // The admin authored neither chat, so both are read-only to them.
    expect(items(body).every((c) => c.readOnly)).toBe(true);
  });

  test("a custom role granted project:read-all sees every chat", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "read-all"] },
    });
    const powerUser = await makeUser({ email: "power@test.com" });
    await makeMember(powerUser.id, organizationId, { role: role.role });
    const { project, ownerChat, viewerChat } = await seedProjectWithTwoChats();
    actingUser = powerUser;

    expect(ids((await listConvos(project.id)).body)).toEqual(
      [ownerChat.id, viewerChat.id].sort(),
    );
  });
});
