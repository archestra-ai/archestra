import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import JiraProvider, { jiraChannelId } from "@/agents/chatops/jira-provider";
import config from "@/config";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import AgentRunAttentionNoticeModel from "@/models/agent-run-attention-notice";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import JiraChatOpsDeliveryModel from "@/models/jira-chatops-delivery";
import { getHiddenMessagingChannels } from "@/services/integration-overrides";
import { A2A_TERMINAL_TASK_STATES } from "@/types/a2a-task";
import type { AgentRunAttentionNotice } from "@/types/agent-run-attention-notice";

/** Delivery is platform-owned: a blocked runtime never calls its ChatOps API. */
export async function handleAgentRunAttentionNotice(
  payload: Record<string, unknown>,
): Promise<void> {
  if (typeof payload.noticeId !== "string") throw new Error("Missing noticeId");
  const notice = await AgentRunAttentionNoticeModel.claim(payload.noticeId);
  if (!notice?.claimId) {
    if (await AgentRunAttentionNoticeModel.find(payload.noticeId)) {
      throw new Error("Runtime attention notice is being delivered");
    }
    return;
  }
  const claim = { id: notice.id, claimId: notice.claimId };
  try {
    const run = await AgentRunModel.findByTaskId(notice.taskId);
    const target = run?.completionTarget;
    if (!run || target?.type !== "chatops") return;
    const binding = await ChatOpsChannelBindingModel.findById(target.bindingId);
    if (
      !binding ||
      binding.organizationId !== run.organizationId ||
      binding.channelId !== notice.channelId ||
      !binding.workspaceId ||
      binding.workspaceId !== notice.workspaceId
    )
      return;
    const runUrl = new URL(
      `/chat/runs/${run.taskId}`,
      config.frontendBaseUrl,
    ).toString();
    if (binding.provider === "jira") {
      if (
        !/^\d+$/.test(target.threadId) ||
        binding.agentId !== run.agentId ||
        (target.pinnedAgentId && target.pinnedAgentId !== run.agentId) ||
        (await getHiddenMessagingChannels(run.organizationId)).has("jira")
      )
        return;
      const jiraConfig = await ChatOpsConfigModel.getJiraConfig();
      const bot = jiraConfig?.bots.find(
        (candidate) =>
          candidate.enabled &&
          candidate.agentId === run.agentId &&
          binding.channelId.startsWith(`${candidate.id}:`),
      );
      if (
        !jiraConfig?.enabled ||
        jiraConfig.id !== notice.workspaceId ||
        jiraConfig.organizationId !== run.organizationId ||
        !bot
      )
        return;
      const projectId = binding.channelId.slice(bot.id.length + 1);
      if (jiraChannelId(bot.id, projectId) !== binding.channelId) return;
      const jira = new JiraProvider(jiraConfig, bot);
      if (!jira.isConfigured()) return;
      await deliverJiraAttentionNotice({
        notice,
        jira,
        threadId: target.threadId,
        runUrl,
      });
      return;
    }
    if (binding.provider !== "slack" || !/^\d+\.\d+$/.test(target.threadId))
      return;
    const slack = await chatOpsManager.getSlackRuntimeNoticeProvider(
      target.pinnedAgentId,
    );
    if (!slack?.isConfigured())
      throw new Error("Slack runtime notice provider unavailable");
    await slack.verifyRuntimeNoticeWorkspace(binding.workspaceId);
    const route = { channelId: notice.channelId, threadId: target.threadId };
    let messageTs = notice.messageTs;
    // A previous post may have succeeded without its response reaching us. Find
    // that message before retrying, including when attention has since cleared.
    if (!messageTs && notice.postAttempted) {
      messageTs = await slack.findRuntimeAttentionNotice({
        ...route,
        noticeId: notice.id,
      });
      if (messageTs)
        await AgentRunAttentionNoticeModel.save({
          ...claim,
          changes: { messageTs },
        });
    }
    if (!messageTs) {
      if (await isResolved(notice.id)) return;
      await AgentRunAttentionNoticeModel.save({
        ...claim,
        changes: { postAttempted: true },
      });
      // Re-read after claiming/persisting; a queued input signal may already be
      // obsolete. A clear during the network call is handled immediately below.
      if (await isResolved(notice.id)) return;
      messageTs = await slack.postRuntimeAttentionNotice({
        ...route,
        noticeId: notice.id,
        runUrl,
      });
      await AgentRunAttentionNoticeModel.save({
        ...claim,
        changes: { messageTs },
      });
    }
    if (!notice.resolvedNotified && (await isResolved(notice.id))) {
      await slack.resolveRuntimeAttentionNotice({
        channelId: route.channelId,
        messageTs,
        runUrl,
      });
      await AgentRunAttentionNoticeModel.save({
        ...claim,
        changes: { resolvedNotified: true },
      });
    }
  } finally {
    await AgentRunAttentionNoticeModel.release(notice.id, notice.claimId);
  }
}

async function deliverJiraAttentionNotice(params: {
  notice: AgentRunAttentionNotice;
  jira: JiraProvider;
  threadId: string;
  runUrl: string;
}): Promise<void> {
  const { notice, jira, threadId, runUrl } = params;
  if (!notice.claimId) throw new Error("Missing Jira notice lease");
  const claim = { id: notice.id, claimId: notice.claimId };
  const route = {
    channelId: notice.channelId,
    threadId,
    noticeId: notice.id,
    runUrl,
  };
  let commentId = notice.messageTs;
  if (!commentId && notice.postAttempted) {
    const operation = await JiraChatOpsDeliveryModel.findByOperationKey({
      integrationId: jira.jiraConfig.id,
      botId: jira.bot.id,
      operationKey: `runtime-attention:${notice.id}`,
    });
    // Only an attempted outbound intent can have created a comment. If the
    // task cleared before network dispatch, suppress the stale notice.
    if (operation?.postAttempted || operation?.completedAt) {
      commentId = await jira.postRuntimeAttentionNotice(route);
      await AgentRunAttentionNoticeModel.save({
        ...claim,
        changes: { messageTs: commentId },
      });
    }
  }
  if (!commentId) {
    if (await isResolved(notice.id)) return;
    await AgentRunAttentionNoticeModel.save({
      ...claim,
      changes: { postAttempted: true },
    });
    if (await isResolved(notice.id)) return;
    commentId = await jira.postRuntimeAttentionNotice(route);
    await AgentRunAttentionNoticeModel.save({
      ...claim,
      changes: { messageTs: commentId },
    });
  }
  if (!notice.resolvedNotified && (await isResolved(notice.id))) {
    await jira.resolveRuntimeAttentionNotice({ ...route, commentId });
    await AgentRunAttentionNoticeModel.save({
      ...claim,
      changes: { resolvedNotified: true },
    });
  }
}

async function isResolved(noticeId: string): Promise<boolean> {
  const notice = await AgentRunAttentionNoticeModel.find(noticeId);
  if (!notice || notice.resolved) return true;
  const run = await AgentRunModel.findByTaskId(notice.taskId);
  if (!run || run.endedAt || run.attentionState !== "input_required")
    return true;
  const task = await A2ATaskModel.findById(run.taskId);
  return !task || A2A_TERMINAL_TASK_STATES.includes(task.state);
}
