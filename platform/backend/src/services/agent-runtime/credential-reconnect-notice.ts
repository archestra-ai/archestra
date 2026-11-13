import { credentialsNeededMessage } from "@/archestra-mcp-server/helpers";
import logger from "@/logging";
import { AgentModel, RuntimeCredentialDefinitionModel } from "@/models";
import type { AgentRunRecord } from "@/types";

/**
 * Tells the person a running run's personal credential stopped working, in
 * the chat thread the run reports to, with a link to connect it again. The
 * run keeps going and picks up the new value on its next credential refresh.
 * Runs that report nowhere (or by email) get nothing: there is no thread.
 */
export async function notifyRunCredentialReconnect(params: {
  session: Pick<
    AgentRunRecord,
    "taskId" | "agentId" | "organizationId" | "completionTarget"
  >;
  credentials: Array<{ key: string; credentialId: string }>;
}): Promise<void> {
  const target = params.session.completionTarget;
  if (target?.type !== "chatops" || params.credentials.length === 0) return;
  try {
    const missing = await Promise.all(
      params.credentials.map(async ({ key, credentialId }) => {
        const definition = await RuntimeCredentialDefinitionModel.find({
          organizationId: params.session.organizationId,
          key: credentialId,
        });
        return { key, label: definition?.name ?? key, reconnect: true };
      }),
    );
    const agent = await AgentModel.findById(params.session.agentId);
    const { chatOpsManager } = await import("@/agents/chatops/chatops-manager");
    await chatOpsManager.notifyBindingThread({
      bindingId: target.bindingId,
      threadId: target.threadId,
      pinnedAgentId: target.pinnedAgentId,
      agentName: agent?.name,
      text: credentialsNeededMessage({
        agentId: params.session.agentId,
        missing,
        duringRun: true,
      }),
      ...(target.conversationReference && {
        conversationReference: target.conversationReference,
      }),
    });
  } catch (error) {
    logger.warn(
      { err: error, taskId: params.session.taskId },
      "Failed to post the credential reconnect notice to the run's thread",
    );
  }
}
