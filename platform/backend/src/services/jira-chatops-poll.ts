import JiraProvider from "@/agents/chatops/jira-provider";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import { getHiddenMessagingChannels } from "@/services/integration-overrides";
import { enqueueJiraChatOpsEvent } from "./jira-chatops-events";

/** The periodic queue has a cross-replica unique active task. A crash replays
 * this bounded window through the inbox's semantic revision dedupe. Cursor CAS
 * prevents a stale worker from moving a newer checkpoint backwards. */
export async function pollJiraChatOps(): Promise<void> {
  const config = await ChatOpsConfigModel.getJiraConfig();
  if (
    !config?.enabled ||
    config.ingressMode !== "poll" ||
    (await getHiddenMessagingChannels(config.organizationId)).has("jira")
  )
    return;
  const until = new Date();
  const cursor = config.pollSince;
  // First enable starts now, never launches agents against historical comments.
  // Ten-minute overlap tolerates Jira enhanced-search indexing delays.
  const started = Date.parse(
    config.pollStartedAt ?? cursor ?? until.toISOString(),
  );
  const since = new Date(
    Math.max(started, Date.parse(cursor ?? until.toISOString()) - 10 * 60_000),
  );
  for (const bot of config.bots.filter((candidate) => candidate.enabled)) {
    const bindings = await ChatOpsChannelBindingModel.findByAgentId(
      bot.agentId,
    );
    const projectIds = bindings
      .filter(
        (binding) =>
          binding.provider === "jira" &&
          binding.organizationId === config.organizationId &&
          binding.workspaceId === config.id &&
          binding.channelId.startsWith(`${bot.id}:`),
      )
      .map((binding) => binding.channelId.slice(bot.id.length + 1));
    const provider = new JiraProvider(config, bot);
    for await (const event of provider.pollCommentEvents({
      projectIds,
      since,
      until,
    })) {
      // The binding is checked again at canonical dispatch and before every write.
      await enqueueJiraChatOpsEvent({
        integrationId: config.id,
        botId: bot.id,
        organizationId: config.organizationId,
        payload: event,
      });
    }
  }
  await ChatOpsConfigModel.updateJiraConfig((current) => {
    if (!current || current.id !== config.id)
      throw new Error("Jira polling integration changed");
    if (
      !current.enabled ||
      current.ingressMode !== "poll" ||
      current.pollSince !== cursor ||
      JSON.stringify(current.bots) !== JSON.stringify(config.bots)
    )
      return current;
    return {
      ...current,
      pollStartedAt: current.pollStartedAt ?? since.toISOString(),
      pollSince: until.toISOString(),
    };
  });
}
