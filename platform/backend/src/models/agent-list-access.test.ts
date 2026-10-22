// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentPinModel from "./agent-pin";

describe("agent list access", () => {
  test("lists and pins preserve grants, tenant, deletion, and proxy fences", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const foreignOrg = await makeOrganization();
    const viewer = await makeUser();
    const author = await makeUser();
    await makeMember(viewer.id, org.id);
    await makeMember(author.id, org.id);
    const shared = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      access: { users: [viewer.id], preset: "view" },
    });
    const privateAgent = await makeAgent({
      organizationId: org.id,
      authorId: author.id,
      access: "personal",
    });
    const foreign = await makeAgent({ organizationId: foreignOrg.id });
    const deleted = await makeAgent({ organizationId: org.id });
    await AgentModel.delete(deleted.id);
    const proxy = await AgentModel.getOrgLlmProxy(org.id);
    const foreignProxy = await AgentModel.getOrgLlmProxy(foreignOrg.id);
    const retiredProxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      isDefault: false,
    });
    for (const agent of [
      shared,
      privateAgent,
      foreign,
      deleted,
      proxy,
      foreignProxy,
      retiredProxy,
    ]) {
      await AgentPinModel.pin({ userId: viewer.id, agentId: agent.id });
    }
    const accessible = await AgentModel.findAccessibleIdsForUser(viewer.id);
    expect(accessible.sort()).toEqual([shared.id, proxy.id].sort());
    const all = await AgentModel.findAll(viewer.id, false, {
      includeTools: false,
    });
    expect(all.map((agent) => agent.id).sort()).toEqual(accessible);
    for (const isAdmin of [false, true]) {
      const pinned = await AgentModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        { pinned: true },
        viewer.id,
        isAdmin,
      );
      expect(pinned.data.map((agent) => agent.id).sort()).toEqual(accessible);
      expect(pinned.pagination.total).toBe(2);
      const deletedList = await AgentModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        { status: "deleted", pinned: true },
        viewer.id,
        isAdmin,
      );
      expect(deletedList.data.map((agent) => agent.id)).toEqual(
        isAdmin ? [deleted.id] : [],
      );
    }
  });

  test("chat pickers offer an admin only their own and shared agents", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    const author = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    await makeMember(author.id, org.id, { role: "member" });
    const otherTeam = await makeTeam(org.id, author.id);
    const mine = await makeInternalAgent({
      organizationId: org.id,
      authorId: admin.id,
      access: "personal",
    });
    const sharedWithMe = await makeInternalAgent({
      organizationId: org.id,
      authorId: author.id,
      access: { users: [admin.id] },
    });
    const orgWide = await makeInternalAgent({
      organizationId: org.id,
      authorId: author.id,
    });
    // Reachable only through the admin's access to every agent.
    await makeInternalAgent({
      organizationId: org.id,
      authorId: author.id,
      access: { teams: [otherTeam.id] },
    });

    const agents = await AgentModel.findUsableChatopsAgents({
      organizationId: org.id,
      userId: admin.id,
      includePersonal: true,
    });

    expect(agents.map((agent) => agent.id).sort()).toEqual(
      [mine.id, sharedWithMe.id, orgWide.id].sort(),
    );
  });
});
