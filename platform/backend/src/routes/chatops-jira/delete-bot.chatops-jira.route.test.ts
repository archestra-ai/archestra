import AuditLogModel from "@/models/audit-log";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { seedJiraConfig, useJiraRouteTest } from "./chatops-jira.test-helpers";

describe("Jira ChatOps delete-bot", () => {
  const { ctx } = useJiraRouteTest();

  test("removes only this bot's bindings and audits removal without credentials", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    const bot = saved.bots[0];
    const own = await ChatOpsChannelBindingModel.create({
      organizationId: ctx.organizationId,
      provider: "jira",
      workspaceId: saved.id,
      channelId: `${bot.id}:10001`,
      agentId: agent.id,
    });
    const other = await ChatOpsChannelBindingModel.create({
      organizationId: ctx.organizationId,
      provider: "jira",
      workspaceId: saved.id,
      channelId: "other-bot:10001",
      agentId: agent.id,
    });
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/chatops/jira/bots/${bot.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots).toEqual([]);
    expect(await ChatOpsChannelBindingModel.findById(own.id)).toBeNull();
    expect(await ChatOpsChannelBindingModel.findById(other.id)).not.toBeNull();
    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceType: "chatOpsConfig",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0].before).not.toEqual(data[0].after);
    expect(JSON.stringify(data)).not.toContain(bot.apiToken);
  });
});
