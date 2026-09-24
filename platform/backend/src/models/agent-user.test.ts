import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import AgentUserModel from "./agent-user";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/**
 * Share `scope` with one user by name, or take that share back. Named sharing
 * is a user grant on the object's policy; the retired share rows no longer
 * decide access.
 */
async function setNamedShare(params: {
  organizationId: string;
  scope: string;
  userId: string;
  shared: boolean;
}) {
  const key = {
    organizationId: params.organizationId,
    resource: "agent" as const,
    scope: params.scope,
  };
  const current = await ResourcePermissionPolicyModel.find(key);
  const others = (current?.grants ?? []).filter(
    (grant) =>
      !(grant.subject.type === "user" && grant.subject.id === params.userId),
  );
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: current?.revision ?? 0,
    grants: params.shared
      ? [
          ...others,
          {
            subject: { type: "user", id: params.userId },
            actions: ["read", "use"],
          },
        ]
      : others,
  });
}

describe("AgentUserModel", () => {
  describe("access", () => {
    test("a personal agent reaches someone it was shared with by name", async ({
      makeUser,
      makeAgent,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const author = await makeUser();
      const colleague = await makeUser();
      await makeMember(author.id, org.id, { role: "member" });
      await makeMember(colleague.id, org.id, { role: "member" });
      const agent = await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        access: "personal",
        authorId: author.id,
      });

      // Before the grant the agent is the author's alone.
      expect(
        await AgentTeamModel.userHasAgentAccess({
          userId: colleague.id,
          agentId: agent.id,
          isAgentAdmin: false,
        }),
      ).toBe(false);

      await setNamedShare({
        organizationId: org.id,
        scope: agent.id,
        userId: colleague.id,
        shared: true,
      });

      expect(
        await AgentTeamModel.userHasAgentAccess({
          userId: colleague.id,
          agentId: agent.id,
          isAgentAdmin: false,
        }),
      ).toBe(true);
      // The author keeps access; sharing adds, it does not move ownership.
      expect(
        await AgentTeamModel.userHasAgentAccess({
          userId: author.id,
          agentId: agent.id,
          isAgentAdmin: false,
        }),
      ).toBe(true);
    });

    test("revoking the grant closes access again", async ({
      makeUser,
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const author = await makeUser();
      const colleague = await makeUser();
      const agent = await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        access: "personal",
        authorId: author.id,
      });

      await setNamedShare({
        organizationId: org.id,
        scope: agent.id,
        userId: colleague.id,
        shared: true,
      });
      await setNamedShare({
        organizationId: org.id,
        scope: agent.id,
        userId: colleague.id,
        shared: false,
      });

      expect(
        await AgentTeamModel.userHasAgentAccess({
          userId: colleague.id,
          agentId: agent.id,
          isAgentAdmin: false,
        }),
      ).toBe(false);
    });

    test("a grant on one agent does not leak to another", async ({
      makeUser,
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const author = await makeUser();
      const colleague = await makeUser();
      const shared = await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        access: "personal",
        authorId: author.id,
      });
      const other = await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        access: "personal",
        authorId: author.id,
      });

      await setNamedShare({
        organizationId: org.id,
        scope: shared.id,
        userId: colleague.id,
        shared: true,
      });

      expect(
        await AgentTeamModel.userHasAgentAccess({
          userId: colleague.id,
          agentId: other.id,
          isAgentAdmin: false,
        }),
      ).toBe(false);
    });

    test("a shared personal agent shows up in the grantee's list", async ({
      makeUser,
      makeAgent,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const author = await makeUser();
      const colleague = await makeUser();
      await makeMember(author.id, org.id, { role: "member" });
      await makeMember(colleague.id, org.id, { role: "member" });
      const agent = await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        access: "personal",
        authorId: author.id,
      });

      expect(
        await AgentModel.findAccessibleIdsForUser(colleague.id),
      ).not.toContain(agent.id);

      await setNamedShare({
        organizationId: org.id,
        scope: agent.id,
        userId: colleague.id,
        shared: true,
      });

      expect(await AgentModel.findAccessibleIdsForUser(colleague.id)).toContain(
        agent.id,
      );
    });
  });

  describe("getUserDetailsForAgents", () => {
    // The "shared with" list reads the agent's grants, not the retired rows,
    // and leaves out the author's own grant.
    test("lists the people the agent's grants reach, other than its author", async ({
      makeUser,
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const author = await makeUser();
      const colleague = await makeUser();
      const agent = await makeAgent({
        organizationId: org.id,
        authorId: author.id,
        access: { users: [author.id, colleague.id], preset: "view" },
      });

      const details = await AgentUserModel.getUserDetailsForAgents([agent.id]);

      expect(details.get(agent.id)).toEqual([
        expect.objectContaining({ id: colleague.id, email: colleague.email }),
      ]);
    });
  });

  describe("syncAgentUsers", () => {
    test("a new grant starts at least privilege", async ({
      makeUser,
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const colleague = await makeUser();
      const agent = await makeAgent({
        organizationId: org.id,
        access: "personal",
      });

      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);

      expect(await AgentUserModel.userHasGrant(agent.id, colleague.id)).toBe(
        true,
      );
    });

    test("a bare id preserves an explicitly-raised level", async ({
      makeUser,
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const colleague = await makeUser();
      const agent = await makeAgent({
        organizationId: org.id,
        access: "personal",
      });

      await AgentUserModel.syncAgentUsers(agent.id, [
        { id: colleague.id, level: "write" },
      ]);
      // Re-syncing by bare id must not silently demote them back to `use`.
      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);

      const granted = await AgentUserModel.filterGrantedIds(
        [agent.id],
        colleague.id,
      );
      expect(granted.has(agent.id)).toBe(true);
    });
  });
});
