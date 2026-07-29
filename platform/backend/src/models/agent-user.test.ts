import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import AgentUserModel from "./agent-user";

describe("AgentUserModel", () => {
  describe("access", () => {
    test("a personal agent reaches someone it was shared with by name", async ({
      makeUser,
      makeAgent,
    }) => {
      const author = await makeUser();
      const colleague = await makeUser();
      const agent = await makeAgent({
        scope: "personal",
        authorId: author.id,
      });

      // Before the grant the agent is the author's alone.
      expect(
        await AgentTeamModel.userHasAgentAccess(colleague.id, agent.id, false),
      ).toBe(false);

      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);

      expect(
        await AgentTeamModel.userHasAgentAccess(colleague.id, agent.id, false),
      ).toBe(true);
      // The author keeps access; sharing adds, it does not move ownership.
      expect(
        await AgentTeamModel.userHasAgentAccess(author.id, agent.id, false),
      ).toBe(true);
    });

    test("revoking the grant closes access again", async ({
      makeUser,
      makeAgent,
    }) => {
      const author = await makeUser();
      const colleague = await makeUser();
      const agent = await makeAgent({
        scope: "personal",
        authorId: author.id,
      });

      await AgentUserModel.syncAgentUsers(agent.id, [colleague.id]);
      await AgentUserModel.syncAgentUsers(agent.id, []);

      expect(
        await AgentTeamModel.userHasAgentAccess(colleague.id, agent.id, false),
      ).toBe(false);
    });

    test("a grant on one agent does not leak to another", async ({
      makeUser,
      makeAgent,
    }) => {
      const author = await makeUser();
      const colleague = await makeUser();
      const shared = await makeAgent({
        scope: "personal",
        authorId: author.id,
      });
      const other = await makeAgent({ scope: "personal", authorId: author.id });

      await AgentUserModel.syncAgentUsers(shared.id, [colleague.id]);

      expect(
        await AgentTeamModel.userHasAgentAccess(colleague.id, other.id, false),
      ).toBe(false);
    });

    test("a shared personal agent shows up in the grantee's list", async ({
      makeUser,
      makeAgent,
    }) => {
      const author = await makeUser();
      const colleague = await makeUser();
      const agent = await makeAgent({
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
    }) => {
      const colleague = await makeUser();
      const agent = await makeAgent({ scope: "personal" });

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
    }) => {
      const colleague = await makeUser();
      const agent = await makeAgent({ scope: "personal" });

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
