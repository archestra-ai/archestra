import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import AgentChatOpsBotModel from "./agent-chatops-bot";
import ChatOpsChannelBindingModel from "./chatops-channel-binding";

describe("agent ChatOps bot cards", () => {
  type Context = Awaited<ReturnType<typeof buildContext>>;
  let context: Context;
  let makeChatOpsBot: (
    organizationId: string,
    overrides?: { provider?: "slack" | "ms-teams" | "telegram"; name?: string },
  ) => Promise<{ id: string }>;
  let makeOrganization: () => Promise<{ id: string }>;

  beforeEach(
    async ({
      makeOrganization: org,
      makeUser,
      makeAgent,
      makeChatOpsBot: bot,
    }) => {
      makeChatOpsBot = bot;
      makeOrganization = org;
      context = await buildContext({
        organization: await org(),
        user: await makeUser(),
        newAgentIn: (params) =>
          makeAgent({
            organizationId: params.organizationId,
            authorId: params.authorId,
            agentType: "agent",
            ...(params.name ? { name: params.name } : {}),
          }),
        makeBot: bot,
      });
    },
  );

  describe("every write path that assigns an agent guarantees a card", () => {
    test("create and upsertByChannel (new and existing channel)", async () => {
      const { organization, botA, botB, newAgent, newBinding } = context;
      const created = await newAgent();
      const upserted = await newAgent();
      const reassigned = await newAgent();

      await newBinding({ botId: botA.id, agentId: created.id });
      await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: organization.id,
        provider: "slack",
        botId: botA.id,
        channelId: "C-new",
        workspaceId: "T-test",
        agentId: upserted.id,
      });
      const existing = await newBinding({ botId: botB.id, agentId: null });
      await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: organization.id,
        provider: "slack",
        botId: botB.id,
        channelId: existing.channelId,
        workspaceId: "T-test",
        agentId: reassigned.id,
      });

      expect(await AgentChatOpsBotModel.findBotIdsByAgent(created.id)).toEqual([
        botA.id,
      ]);
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(upserted.id)).toEqual(
        [botA.id],
      );
      expect(
        await AgentChatOpsBotModel.findBotIdsByAgent(reassigned.id),
      ).toEqual([botB.id]);
    });

    test("createPendingDmIfAbsent adds the card only when a row is inserted", async () => {
      const { organization, botA, newAgent } = context;
      const first = await newAgent();
      const second = await newAgent();
      const input = {
        organizationId: organization.id,
        provider: "slack" as const,
        botId: botA.id,
        channelId: "dm:pending:someone",
        workspaceId: "dm:pending",
        isDm: true,
        dmOwnerEmail: "someone@example.com",
      };

      const inserted = await ChatOpsChannelBindingModel.createPendingDmIfAbsent(
        {
          ...input,
          agentId: first.id,
        },
      );
      const skipped = await ChatOpsChannelBindingModel.createPendingDmIfAbsent({
        ...input,
        agentId: second.id,
      });

      expect(inserted).not.toBeNull();
      expect(skipped).toBeNull();
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(first.id)).toEqual([
        botA.id,
      ]);
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(second.id)).toEqual(
        [],
      );
    });

    test("update and updateByIdAndOrganization", async () => {
      const { organization, botA, botB, newAgent, newBinding } = context;
      const viaUpdate = await newAgent();
      const viaOrgUpdate = await newAgent();
      const first = await newBinding({ botId: botA.id, agentId: null });
      const second = await newBinding({ botId: botB.id, agentId: null });

      await ChatOpsChannelBindingModel.update(first.id, {
        agentId: viaUpdate.id,
      });
      await ChatOpsChannelBindingModel.updateByIdAndOrganization({
        id: second.id,
        organizationId: organization.id,
        input: { agentId: viaOrgUpdate.id },
      });

      expect(
        await AgentChatOpsBotModel.findBotIdsByAgent(viaUpdate.id),
      ).toEqual([botA.id]);
      expect(
        await AgentChatOpsBotModel.findBotIdsByAgent(viaOrgUpdate.id),
      ).toEqual([botB.id]);
    });

    test("bulkUpdateAgent adds one card per bot of the assigned channels", async () => {
      const { organization, botA, botB, newAgent, newBinding } = context;
      const agent = await newAgent();
      const ids = [
        (await newBinding({ botId: botA.id, agentId: null })).id,
        (await newBinding({ botId: botA.id, agentId: null })).id,
        (await newBinding({ botId: botB.id, agentId: null })).id,
      ];

      await ChatOpsChannelBindingModel.bulkUpdateAgent({
        ids,
        organizationId: organization.id,
        agentId: agent.id,
      });

      expect(
        (await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).sort(),
      ).toEqual([botA.id, botB.id].sort());
    });

    test("unassigning or assigning nobody never creates a card, and releasing a channel keeps the card", async () => {
      const { organization, botA, newAgent, newBinding } = context;
      const agent = await newAgent();
      await newBinding({ botId: botA.id, agentId: null });
      const held = await newBinding({ botId: botA.id, agentId: agent.id });

      await ChatOpsChannelBindingModel.bulkUpdateAgent({
        ids: [held.id],
        organizationId: organization.id,
        agentId: null,
      });

      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        botA.id,
      ]);
      expect(await AgentChatOpsBotModel.findAgentsByBot(botA.id)).toEqual([
        { id: agent.id, name: expect.any(String) },
      ]);
    });

    test("assigning more channels under the same bot keeps a single card", async () => {
      const { botA, newAgent, newBinding } = context;
      const agent = await newAgent();

      await newBinding({ botId: botA.id, agentId: agent.id });
      await newBinding({ botId: botA.id, agentId: agent.id });

      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        botA.id,
      ]);
    });
  });

  describe("findAgentsByBotIds", () => {
    test("unions cards with agents holding channels, deduplicated and sorted by name", async () => {
      const { botA, botB, newAgent, newBinding } = context;
      const zed = await newAgent("Zed");
      const alpha = await newAgent("Alpha");
      const legacy = await newAgent("Legacy");
      // Zed: card and channel. Alpha: card only (no channel yet).
      await newBinding({ botId: botA.id, agentId: zed.id });
      await db
        .insert(schema.agentChatopsBotsTable)
        .values({ agentId: alpha.id, botId: botA.id });
      // Legacy: a channel written before cards existed (no card row).
      await newBinding({ botId: botA.id, agentId: legacy.id });
      await db
        .delete(schema.agentChatopsBotsTable)
        .where(
          and(
            eq(schema.agentChatopsBotsTable.agentId, legacy.id),
            eq(schema.agentChatopsBotsTable.botId, botA.id),
          ),
        );

      const byBot = await AgentChatOpsBotModel.findAgentsByBotIds([
        botA.id,
        botB.id,
      ]);

      expect(byBot.get(botA.id)).toEqual([
        { id: alpha.id, name: "Alpha" },
        { id: legacy.id, name: "Legacy" },
        { id: zed.id, name: "Zed" },
      ]);
      expect(byBot.get(botB.id)).toEqual([]);
    });

    test("returns an empty map for no bots", async () => {
      expect((await AgentChatOpsBotModel.findAgentsByBotIds([])).size).toBe(0);
    });
  });

  describe("findConflictingCard", () => {
    test("reports the other bot of the same provider, never the claimed bot or another provider", async () => {
      const { organization, botA, botB, newAgent, newBinding } = context;
      const agent = await newAgent();
      await newBinding({ botId: botA.id, agentId: agent.id });
      const teams = await makeChatOpsBot(organization.id, {
        provider: "ms-teams",
      });

      expect(
        await AgentChatOpsBotModel.findConflictingCard({
          agentId: agent.id,
          botId: botB.id,
          provider: "slack",
        }),
      ).toEqual({ botId: botA.id, name: "Bot A" });
      expect(
        await AgentChatOpsBotModel.findConflictingCard({
          agentId: agent.id,
          botId: botA.id,
          provider: "slack",
        }),
      ).toBeNull();
      expect(
        await AgentChatOpsBotModel.findConflictingCard({
          agentId: agent.id,
          botId: teams.id,
          provider: "ms-teams",
        }),
      ).toBeNull();
    });
  });

  describe("applyAssignmentPlan with bots", () => {
    const plan = (
      fixtures: Context,
      overrides: {
        targetAgentId: string;
        bots?: string[];
        updates?: Array<{
          bindingId: string;
          expectedAgentId: string | null;
          nextAgentId: string | null;
        }>;
        directMessages?: Array<{ provider: "slack"; botId: string }>;
      },
    ) =>
      ChatOpsChannelBindingModel.applyAssignmentPlan({
        organizationId: fixtures.organization.id,
        userId: fixtures.user.id,
        dmOwnerEmail: fixtures.user.email,
        updates: [],
        directMessages: [],
        ...overrides,
      });

    test("a plan with only `bots` adds the cards without touching any channel", async () => {
      const { botA, newAgent, newBinding } = context;
      const agent = await newAgent();
      const untouched = await newBinding({ botId: botA.id, agentId: null });

      const result = await plan(context, {
        targetAgentId: agent.id,
        bots: [botA.id],
      });

      expect(result).toEqual([]);
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        botA.id,
      ]);
      expect(
        (await ChatOpsChannelBindingModel.findById(untouched.id))?.agentId,
      ).toBeNull();
    });

    test("dropping a bot releases its channels and DMs and deletes the card, leaving other bots alone", async () => {
      const { organization, botA, newAgent, newBinding } = context;
      const teams = await makeChatOpsBot(organization.id, {
        provider: "ms-teams",
      });
      const agent = await newAgent();
      const channel = await newBinding({ botId: botA.id, agentId: agent.id });
      const dm = await newBinding({
        botId: botA.id,
        agentId: agent.id,
        isDm: true,
      });
      const kept = await ChatOpsChannelBindingModel.create({
        organizationId: organization.id,
        provider: "ms-teams",
        botId: teams.id,
        channelId: "teams-channel",
        workspaceId: "tenant",
        agentId: agent.id,
      });

      await plan(context, { targetAgentId: agent.id, bots: [teams.id] });

      expect(
        (await ChatOpsChannelBindingModel.findById(channel.id))?.agentId,
      ).toBeNull();
      expect(
        (await ChatOpsChannelBindingModel.findById(dm.id))?.agentId,
      ).toBeNull();
      expect(
        (await ChatOpsChannelBindingModel.findById(kept.id))?.agentId,
      ).toBe(agent.id);
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        teams.id,
      ]);
    });

    test("an empty `bots` set releases everything the agent held", async () => {
      const { botA, newAgent, newBinding } = context;
      const agent = await newAgent();
      const channel = await newBinding({ botId: botA.id, agentId: agent.id });

      await plan(context, { targetAgentId: agent.id, bots: [] });

      expect(
        (await ChatOpsChannelBindingModel.findById(channel.id))?.agentId,
      ).toBeNull();
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual(
        [],
      );
    });

    test("assigning a channel or DM under a bot missing from `bots` is a 400 and changes nothing", async () => {
      const { botA, botB, newAgent, newBinding } = context;
      const agent = await newAgent();
      const channel = await newBinding({ botId: botB.id, agentId: null });

      await expect(
        plan(context, {
          targetAgentId: agent.id,
          bots: [botA.id],
          updates: [
            {
              bindingId: channel.id,
              expectedAgentId: null,
              nextAgentId: agent.id,
            },
          ],
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("Add the bot"),
      });
      await expect(
        plan(context, {
          targetAgentId: agent.id,
          bots: [botA.id],
          directMessages: [{ provider: "slack", botId: botB.id }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(
        (await ChatOpsChannelBindingModel.findById(channel.id))?.agentId,
      ).toBeNull();
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual(
        [],
      );
    });

    test("two bots of one provider in the final set is a 400", async () => {
      const { botA, botB, newAgent } = context;
      const agent = await newAgent();

      await expect(
        plan(context, { targetAgentId: agent.id, bots: [botA.id, botB.id] }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual(
        [],
      );
    });

    test("an unknown bot, or a bot of another organization, is a 404", async () => {
      const { newAgent } = context;
      const agent = await newAgent();
      const otherOrganization = await makeOrganization();
      const foreignBot = await makeChatOpsBot(otherOrganization.id);

      await expect(
        plan(context, { targetAgentId: agent.id, bots: [crypto.randomUUID()] }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        plan(context, { targetAgentId: agent.id, bots: [foreignBot.id] }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual(
        [],
      );
    });

    test("without `bots` the current cards are kept and the assigned channels' bots are added", async () => {
      const { organization, botA, newAgent, newBinding } = context;
      const teams = await makeChatOpsBot(organization.id, {
        provider: "ms-teams",
      });
      const agent = await newAgent();
      await db
        .insert(schema.agentChatopsBotsTable)
        .values({ agentId: agent.id, botId: teams.id });
      const channel = await newBinding({ botId: botA.id, agentId: null });

      await plan(context, {
        targetAgentId: agent.id,
        updates: [
          {
            bindingId: channel.id,
            expectedAgentId: null,
            nextAgentId: agent.id,
          },
        ],
      });

      expect(
        (await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).sort(),
      ).toEqual([botA.id, teams.id].sort());
    });

    test("without `bots`, a channel of a second same-provider bot is a 400", async () => {
      const { botA, botB, newAgent, newBinding } = context;
      const agent = await newAgent();
      await newBinding({ botId: botA.id, agentId: agent.id });
      const other = await newBinding({ botId: botB.id, agentId: null });

      await expect(
        plan(context, {
          targetAgentId: agent.id,
          updates: [
            {
              bindingId: other.id,
              expectedAgentId: null,
              nextAgentId: agent.id,
            },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(
        (await ChatOpsChannelBindingModel.findById(other.id))?.agentId,
      ).toBeNull();
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        botA.id,
      ]);
    });

    test("replacing the bot in one plan releases the old bot's channels and assigns the new one's", async () => {
      const { botA, botB, newAgent, newBinding } = context;
      const agent = await newAgent();
      const old = await newBinding({ botId: botA.id, agentId: agent.id });
      const next = await newBinding({ botId: botB.id, agentId: null });

      await plan(context, {
        targetAgentId: agent.id,
        bots: [botB.id],
        updates: [
          { bindingId: next.id, expectedAgentId: null, nextAgentId: agent.id },
        ],
      });

      expect((await ChatOpsChannelBindingModel.findById(old.id))?.agentId).toBe(
        null,
      );
      expect(
        (await ChatOpsChannelBindingModel.findById(next.id))?.agentId,
      ).toBe(agent.id);
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        botB.id,
      ]);
    });
  });
});

async function buildContext(params: {
  organization: { id: string };
  user: { id: string; email: string };
  newAgentIn: (p: {
    organizationId: string;
    authorId: string;
    name?: string;
  }) => Promise<{ id: string }>;
  makeBot: (
    organizationId: string,
    overrides?: { name?: string },
  ) => Promise<{ id: string }>;
}) {
  const { organization, user } = params;
  const botA = await params.makeBot(organization.id, { name: "Bot A" });
  const botB = await params.makeBot(organization.id, { name: "Bot B" });
  const newAgent = (name?: string) =>
    params.newAgentIn({
      organizationId: organization.id,
      authorId: user.id,
      name,
    });
  const newBinding = (binding: {
    botId: string;
    agentId: string | null;
    isDm?: boolean;
  }) =>
    ChatOpsChannelBindingModel.create({
      organizationId: organization.id,
      provider: "slack",
      botId: binding.botId,
      channelId: `C${crypto.randomUUID().slice(0, 10)}`,
      workspaceId: "T-test",
      agentId: binding.agentId,
      isDm: binding.isDm ?? false,
      dmOwnerEmail: binding.isDm ? user.email : null,
    });
  return { organization, user, botA, botB, newAgent, newBinding };
}
