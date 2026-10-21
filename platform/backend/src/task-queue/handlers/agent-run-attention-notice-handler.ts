import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import config from "@/config";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import AgentRunAttentionNoticeModel from "@/models/agent-run-attention-notice";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import { A2A_TERMINAL_TASK_STATES } from "@/types/a2a-task";

/** Delivery is platform-owned: a blocked runtime never has to call Slack. */
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
    if (
      !run ||
      target?.type !== "chatops" ||
      !/^\d+\.\d+$/.test(target.threadId)
    )
      return;
    const binding = await ChatOpsChannelBindingModel.findById(target.bindingId);
    if (
      !binding ||
      binding.provider !== "slack" ||
      binding.organizationId !== run.organizationId ||
      binding.channelId !== notice.channelId ||
      !binding.workspaceId ||
      binding.workspaceId !== notice.workspaceId
    )
      return;
    const slack = await chatOpsManager.getSlackRuntimeNoticeProvider(
      target.pinnedAgentId,
    );
    if (!slack?.isConfigured())
      throw new Error("Slack runtime notice provider unavailable");
    await slack.verifyRuntimeNoticeWorkspace(binding.workspaceId);
    const route = { channelId: notice.channelId, threadId: target.threadId };
    const runUrl = new URL(
      `/chat/runs/${run.taskId}`,
      config.frontendBaseUrl,
    ).toString();
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

async function isResolved(noticeId: string): Promise<boolean> {
  const notice = await AgentRunAttentionNoticeModel.find(noticeId);
  if (!notice || notice.resolved) return true;
  const run = await AgentRunModel.findByTaskId(notice.taskId);
  if (!run || run.endedAt || run.attentionState !== "input_required")
    return true;
  const task = await A2ATaskModel.findById(run.taskId);
  return !task || A2A_TERMINAL_TASK_STATES.includes(task.state);
}
