import type { ConnectorClient, TurnContext } from "@microsoft/agents-hosting";
import { Client } from "@microsoft/teams.api";

/** Teams directory operations using the authenticated Agents SDK connector. */
export const msTeamsDirectory = {
  getTeamDetails(context: TurnContext) {
    return getClient(context).teams.getById(getTeamId(context));
  },
  getTeamChannels(context: TurnContext) {
    return getClient(context).teams.getConversations(getTeamId(context));
  },
  getMember(context: TurnContext, userId: string) {
    const teamId = context.activity.channelData?.team?.id as string | undefined;
    const conversationId = teamId || context.activity.conversation?.id;
    if (!conversationId) throw new Error("Missing Teams conversation ID");
    return getClient(context)
      .conversations.members(conversationId)
      .getById(userId);
  },
};

function getTeamId(context: TurnContext): string {
  const teamId = context.activity.channelData?.team?.id as string | undefined;
  if (!teamId) throw new Error("Missing Teams team ID");
  return teamId;
}

function getClient(context: TurnContext): Client {
  const connector = context.turnState.get<ConnectorClient>(
    context.adapter.ConnectorClientKey,
  );
  if (!connector) throw new Error("Missing authenticated Teams connector");
  return new Client(connector.httpClient.baseURL.replace(/\/+$/, ""), {
    headers: { ...connector.httpClient.defaultHeaders },
  });
}
