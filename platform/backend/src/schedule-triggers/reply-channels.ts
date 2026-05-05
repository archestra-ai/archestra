import { ChatOpsChannelBindingModel, ChatOpsConfigModel } from "@/models";
import type { ScheduleTriggerReplyChannel } from "@/types";

export type SlackDmReplyBinding = {
  channelId: string;
  workspaceId: string | null;
};

export async function getReplyChannelDeliveryContext(params: {
  actorEmail: string | null;
}): Promise<{
  availableChannels: ScheduleTriggerReplyChannel[];
  slackDmBinding: SlackDmReplyBinding | null;
}> {
  const availableChannels: ScheduleTriggerReplyChannel[] = ["chat"];
  let slackDmBinding: SlackDmReplyBinding | null = null;

  if (!params.actorEmail) {
    return { availableChannels, slackDmBinding };
  }

  const slackConfig = await ChatOpsConfigModel.getSlackConfig();
  if (!slackConfig?.enabled) {
    return { availableChannels, slackDmBinding };
  }

  const dm = await ChatOpsChannelBindingModel.findDmBindingByEmail(
    "slack",
    params.actorEmail,
  );
  if (dm) {
    availableChannels.push("slack_dm");
    slackDmBinding = {
      channelId: dm.channelId,
      workspaceId: dm.workspaceId,
    };
  }

  return { availableChannels, slackDmBinding };
}

export async function getAvailableReplyChannels(params: {
  actorEmail: string | null;
}): Promise<ScheduleTriggerReplyChannel[]> {
  const { availableChannels } = await getReplyChannelDeliveryContext(params);
  return availableChannels;
}
