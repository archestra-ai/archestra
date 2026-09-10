import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import AgentUserModel from "./agent-user";

describe("AgentUserModel", () => {
  describe("access", () => {
    test("a personal agent reaches someone it was shared with by name", async ({
      makeUser,
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const author = await makeUser();
      const colleague = await makeUser();
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "personal",
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

      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);

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
        scope: "personal",
        authorId: author.id,
      });

      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);
      await AgentUserModel.syncAgentUsers(agent.id, []);

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
        scope: "personal",
        authorId: author.id,
      });
      const other = await makeAgent({
        organizationId: org.id,
        scope: "personal",
        authorId: author.id,
      });

      await AgentUserModel.syncAgentUsers(shared.id, [colleague.id]);

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
    }) => {
      const org = await makeOrganization({ legacyPermissions: true });
      const author = await makeUser();
      const colleague = await makeUser();
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "personal",
        authorId: author.id,
      });

      expect(
        await AgentModel.findAccessibleIdsForUser(colleague.id),
      ).not.toContain(agent.id);

      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);

      expect(await AgentModel.findAccessibleIdsForUser(colleague.id)).toContain(
        agent.id,
      );
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
        scope: "personal",
      });

      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);

      const details = await AgentUserModel.getUserDetailsForAgents([agent.id]);
      expect(details.get(agent.id)).toEqual([
        expect.objectContaining({ id: colleague.id }),
      ]);
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
        scope: "personal",
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
