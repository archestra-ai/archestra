import { coerceMalformedToolInputs } from "@archestra/shared";
import {
  convertToModelMessages,
  type FilePart,
  type ModelMessage,
  type TextPart,
  type TextUIPart,
  type UIMessage,
} from "ai";
import logger from "@/logging";
import {
  A2AMessageModel,
  AgentModel,
  AgentTeamModel,
  TeamModel,
  UserModel,
} from "@/models";
import { RouteCategory, startActiveChatSpan } from "@/observability/tracing";
import { validateMCPGatewayToken } from "@/routes/mcp-gateway.utils";
import type { A2AContext } from "@/types";
import type { InteractionSource } from "../../../../shared";
import { type A2AAttachment, executeA2AMessage } from "../a2a-executor";
import { type A2AActor, A2AError, A2AErrorKind } from "./a2a-base";
import {
  A2AContextManager,
  A2ATaskManager,
  type A2ATaskWithData,
  getApprovalRequestsMap,
} from "./a2a-model-manager";
import {
  type A2AArchestraApprovalRequest,
  type A2AArchestraTaskApprovalDecision,
  type A2AArchestraTaskOps,
  type A2AProtocolGetTaskRequest,
  type A2AProtocolMessage,
  type A2AProtocolPart,
  A2AProtocolRole,
  type A2AProtocolSendMessageRequest,
  type A2AProtocolSendMessageResponse,
  type A2AProtocolTask,
  A2AProtocolTaskState,
} from "./a2a-protocol";

interface A2AManagerConfig {
  /**
   * In statless mode A2AManager:
   * - Does not save context/task/messages in the db by default.
   * - Does not retrieve full messages history from the db at the message execution.
   * - May create context/task/message in special cases like approval flows.
   *
   * Default: false (= stateful mode)
   */
  stateless?: boolean;

  /**
   * When approval flow mode is on and agent respond with approval request:
   * - Agent is allowed to respond with an approval request:
   *   - Creates a task with InputRequired status and metadata with approvalId/etc
   *   - Creates a context for this task
   *       (if doesn't exist because of stateless mode)
   *   - Creates a message with state "approval-requested"
   *       (if doesn't exist because of stateless mode)
   * - Support requests messages with approval decisions in metadata
   *   - Approval decisions are updated in the last message of the context
   *   - On completed decisions in the last message, the task is automatically resumed
   *       and the message is returned
   *   - On incompleted decisions, the task remains in InputRequired status
   *       and the task is returned
   * When approval flow mode is off:
   * - Agent is not allowed to respond with approval requests
   * - User is not allowed to send approval decisions in the message metadata
   *
   * Default: false (= approval flow is on)
   */
  disableApprovalFlow?: boolean;
}

export class A2AManager {
  private readonly config: A2AManagerConfig;

  constructor(config?: A2AManagerConfig) {
    this.config = config ?? {};
  }

  public async sendMessage(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolSendMessageRequest;
    // systemParams are currently used for passing through to executeA2AMessage(...)
    systemParams?: {
      sessionId?: string;
      source?: InteractionSource;
      routeCategory?: RouteCategory;
      chatOpsBindingId?: string;
      chatOpsThreadId?: string;
    };
    /**
     * Cancellation signal forwarded into the agent run. Used by chatops so a
     * muted thread aborts its in-flight model requests instead of letting them
     * finish and post a now-unwanted reply.
     */
    abortSignal?: AbortSignal;
  }): Promise<A2AProtocolSendMessageResponse> {
    try {
      const { actor, agentId, request, systemParams, abortSignal } = params;

      const [a2aUser, agent] = await Promise.all([
        actor.kind === "user" && actor.id !== "system"
          ? UserModel.getById(actor.id)
          : null,
        AgentModel.findById(agentId),
      ]);
      if (!agent) {
        throw new A2AError(A2AErrorKind.AgentNotFound);
      }

      let task: A2ATaskWithData | undefined;
      let context: A2AContext | undefined;
      if (request.message.taskId) {
        const { task: fetchedTask, context: fetchedContext } =
          await A2ATaskManager.findAndValidateTaskWithContext(
            request.message.taskId,
            undefined,
            actor,
          );
        task = fetchedTask;
        context = fetchedContext;
        if (
          request.message.contextId &&
          context.id !== request.message.contextId
        ) {
          throw new A2AError(A2AErrorKind.TaskContextMismatch);
        }
      }
      if (!context && request.message.contextId) {
        context = await A2AContextManager.findAndValidateContext(
          request.message.contextId,
          actor,
        );
      }

      let taskWasSwitchedToWorkingState: boolean | undefined = false;
      let taskApprovalDecisionsWasApplied: boolean | undefined = false;

      if (task) {
        if (!context) {
          // This should never happen: context must be found above when validating task with context.
          throw new Error("[A2AManager] Task without context");
        }
        const taskOps = request.message.metadata?.taskOps;
        if (taskOps) {
          const {
            task: updatedTask,
            switchedToWorkingState,
            approvalDecisionsWasApplied,
          } = await this.processTaskOps({ task, taskOps });
          task = updatedTask;
          taskWasSwitchedToWorkingState = switchedToWorkingState;
          taskApprovalDecisionsWasApplied = approvalDecisionsWasApplied;
        }
      }

      const messageParts: (TextPart | FilePart)[] = [];
      (request.message.parts || []).forEach((p) => {
        if (p.text !== undefined) {
          messageParts.push({ type: "text" as const, text: p.text });
          return;
        }
        if (p.raw !== undefined && p.mediaType) {
          messageParts.push({
            type: "file" as const,
            data: p.raw,
            mediaType: p.mediaType,
          });
          return;
        }
      });

      const needToExecute =
        messageParts.length > 0 || taskWasSwitchedToWorkingState;
      if (!needToExecute) {
        if (taskApprovalDecisionsWasApplied) {
          if (!task) {
            // This should never happen. Task must be defined if approval decisions were applied.
            throw new Error(
              "[A2AManager] No task when approval decisions were applied",
            );
          }
          return { task: A2ATaskManager.toProtocolTask(task) };
        }
        throw new A2AError(A2AErrorKind.NothingToExecute);
      }

      // Fetch history messages from the db
      const contextDbMessages =
        !this.config.stateless && context
          ? await A2AContextManager.getContextMessagesWithOverrides({
              context,
              override: task?.history || [],
            })
          : task && taskWasSwitchedToWorkingState
            ? task.history
            : [];
      // Repair malformed tool inputs at the source so both the provider request
      // and the UI-continuation copy (`originalUiMessages` below) stay valid.
      const contextUiMessages = coerceMalformedToolInputs(
        contextDbMessages.map((m) => m.content as UIMessage),
      );
      const requestMessages: ModelMessage[] =
        await convertToModelMessages(contextUiMessages);

      // The executor owns building the current user turn: it applies
      // model-aware, provider-specific attachment handling, so we pass the
      // turn's text + attachments rather than baking it into `requestMessages`
      // (which stays prior-context only). Attachments are reconstructed from the
      // protocol file parts, preserving filenames.
      const currentTurnAttachments: A2AAttachment[] = (
        request.message.parts || []
      )
        .filter((p) => p.raw !== undefined && p.mediaType !== undefined)
        .map((p) => ({
          contentType: p.mediaType as string,
          contentBase64: Buffer.from(p.raw as Uint8Array).toString("base64"),
          name: p.filename,
        }));
      const currentTurnText = messageParts
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n");

      if (messageParts.length > 0) {
        // Mirror the current turn's text into contextUiMessages so the
        // generated final UIMessage continues from it. Files are not supported
        // in UI history, so only text parts are carried here.
        const uiMessageParts: TextUIPart[] = [];
        messageParts.forEach((part) => {
          if (part.type === "text") {
            uiMessageParts.push({ type: "text" as const, text: part.text });
          }
        });
        contextUiMessages.push({
          id: request.message.messageId,
          parts: uiMessageParts,
          role: "user",
        });
      }

      const sessionId = systemParams?.sessionId ?? context?.id;
      const [teams, userTeams] = await Promise.all([
        AgentTeamModel.getTeamLabelInfoForAgent(agentId),
        a2aUser
          ? TeamModel.getTeamLabelInfoForUser({
              userId: a2aUser.id,
              organizationId: agent.organizationId,
            })
          : [],
      ]);
      const result = await startActiveChatSpan({
        agentName: agent.name,
        agentId,
        agentType: agent.agentType ?? undefined,
        sessionId,
        teams,
        userTeams,
        routeCategory: systemParams?.routeCategory ?? RouteCategory.A2A,
        user: a2aUser
          ? { id: a2aUser.id, email: a2aUser.email, name: a2aUser.name }
          : null,
        callback: async () => {
          return executeA2AMessage({
            agentId,
            message: currentTurnText,
            attachments:
              currentTurnAttachments.length > 0
                ? currentTurnAttachments
                : undefined,
            messages: requestMessages,
            organizationId: actor.organizationId,
            userId: actor.kind === "user" ? actor.id : "system",
            sessionId,
            source: systemParams?.source,
            parentDelegationChain: undefined, // This is the root call, chain starts with agentId
            blockOnApprovalRequired: false, // No need to block. We check approval flow availability below
            originalUiMessages: contextUiMessages,
            chatOpsBindingId: systemParams?.chatOpsBindingId,
            chatOpsThreadId: systemParams?.chatOpsThreadId,
            abortSignal,
          });
        },
      });

      if (!this.config.stateless && !context) {
        // In stateful mode context should be created in the db on every successful execution
        context = await A2AContextManager.createContext(actor);
      }

      let userMessageSavedInDb = false;
      const saveUserMessageInDb = async () => {
        if (userMessageSavedInDb) {
          return;
        }
        if (messageParts.length > 0) {
          if (!context) {
            // This should never happen: context must be defined before.
            throw new Error(
              "[A2AManager] No context when inserting user message in the db",
            );
          }
          const uiMessageParts: TextUIPart[] = [];
          messageParts.forEach((part) => {
            if (part.type === "text") {
              uiMessageParts.push({ type: "text" as const, text: part.text });
            }
            // Files are currently not supported in history.
          });
          const userUiMessage: UIMessage = {
            id: request.message.messageId,
            parts: uiMessageParts,
            role: "user",
          };
          if (task) {
            const { task: updatedTask } = await A2ATaskManager.addMessageToTask(
              {
                task,
                message: request.message,
                uiMessage: userUiMessage,
              },
            );
            task = updatedTask;
          } else {
            await A2AContextManager.addMessageToContext({
              context,
              message: request.message,
              uiMessage: userUiMessage,
            });
          }
        }
        userMessageSavedInDb = true;
      };

      const approvalRequests = extractApprovalRequestsFromUiMessage(
        result.responseUiMessage,
      );

      if (approvalRequests.length > 0) {
        if (this.config.disableApprovalFlow) {
          throw new A2AError(A2AErrorKind.OutputApprovalFlowIsDisabled);
        }

        if (task) {
          task = await A2ATaskManager.addApprovalRequestsToTask(
            task,
            approvalRequests,
          );
          task = await A2ATaskManager.updateTaskState(
            task,
            A2AProtocolTaskState.InputRequired,
          );
        } else {
          if (!context) {
            if (!this.config.stateless) {
              // This should never happen. Context exists in stateful mode.
              throw new Error(
                "[A2AManager] No context in stateful mode when processing approval requests",
              );
            }
            context = await A2AContextManager.createContext(actor);
          }
          task = await A2ATaskManager.createTask({
            context,
            actor,
            state: A2AProtocolTaskState.InputRequired,
            approvalRequests,
          });
        }

        // In approval flow user message must be created in the db even in the stateless mode.
        await saveUserMessageInDb();

        // In approval flow the agent message is persisted even in stateless mode.
        const { task: updatedTask } = await this.persistAgentMessage({
          context,
          task,
          responseUiMessage: result.responseUiMessage,
          stateless: false,
        });
        task = updatedTask ?? task;

        return { task: A2ATaskManager.toProtocolTask(task) };
      }

      if (!this.config.stateless) {
        // In stateful mode user message should be created in the db on every successful execution
        await saveUserMessageInDb();
      }

      const {
        resultMessage,
        task: persistedTask,
        context: persistedContext,
      } = await this.persistAgentMessage({
        context,
        task,
        responseUiMessage: result.responseUiMessage,
        stateless: Boolean(this.config.stateless),
      });
      task = persistedTask ?? task;
      context = persistedContext ?? context;

      if (task && task.state !== A2AProtocolTaskState.Completed) {
        await A2ATaskManager.updateTaskState(
          task,
          A2AProtocolTaskState.Completed,
        );
      }

      return { message: resultMessage };
    } catch (error) {
      if (error instanceof A2AError) {
        throw error;
      }
      logger.error(
        { error, actor: params.actor, agentId: params.agentId },
        "[A2AManager] Error in sendMessage",
      );
      throw error;
    }
  }

  /**
   * Persist the agent response message and return the protocol message.
   * - stateless: returns the message literal, no DB write.
   * - task present: writes via addMessageToTask (updates an existing approval message in place).
   * - context only: writes via addMessageToContext.
   */
  private async persistAgentMessage(args: {
    context: A2AContext | undefined;
    task: A2ATaskWithData | undefined;
    responseUiMessage: UIMessage;
    stateless: boolean;
  }): Promise<{
    resultMessage: A2AProtocolMessage;
    task?: A2ATaskWithData;
    context?: A2AContext;
  }> {
    const { context, task, responseUiMessage, stateless } = args;
    const parts = extractProtocolPartsFromUIMessage(responseUiMessage);

    if (stateless) {
      return {
        resultMessage: {
          messageId: responseUiMessage.id,
          contextId: context?.id,
          taskId: task?.id,
          role: A2AProtocolRole.Agent,
          parts,
        },
      };
    }

    if (!context) {
      // This should never happen: context is always defined in the stateful mode.
      throw new Error("[A2AManager] No context when saving message to db");
    }

    if (task) {
      const { task: updatedTask, protocolMessage } =
        await A2ATaskManager.addMessageToTask({
          task,
          message: {
            messageId: responseUiMessage.id,
            contextId: context.id,
            role: A2AProtocolRole.Agent,
            parts,
          },
          uiMessage: responseUiMessage,
        });
      return { resultMessage: protocolMessage, task: updatedTask };
    }

    const { context: updatedContext, protocolMessage } =
      await A2AContextManager.addMessageToContext({
        context,
        message: {
          messageId: responseUiMessage.id,
          role: A2AProtocolRole.Agent,
          parts,
        },
        uiMessage: responseUiMessage,
      });
    return { resultMessage: protocolMessage, context: updatedContext };
  }

  async processTaskOps(params: {
    task: A2ATaskWithData;
    taskOps: A2AArchestraTaskOps;
  }): Promise<{
    task: A2ATaskWithData;
    switchedToWorkingState?: boolean;
    approvalDecisionsWasApplied?: boolean;
  }> {
    const { taskOps } = params;
    let { task } = params;

    const approvalDecisions = taskOps.approvalDecisions ?? [];
    if (approvalDecisions.length > 0) {
      if (this.config.disableApprovalFlow) {
        throw new A2AError(A2AErrorKind.InputApprovalFlowIsDisabled);
      }
      if (task.state !== A2AProtocolTaskState.InputRequired) {
        throw new A2AError(A2AErrorKind.TaskIsNotInputRequired);
      }

      // Approval decisions must correspond to approval requests in the task and not be already resolved
      const approvalRequestsMapFromTask: Record<
        string,
        A2AArchestraApprovalRequest
      > = getApprovalRequestsMap(task.approvalRequests);
      for (const decision of approvalDecisions) {
        const approvalRequestFromTask =
          approvalRequestsMapFromTask[decision.approvalId];
        if (!approvalRequestFromTask) {
          throw new A2AError(A2AErrorKind.ApprovalIdNotFound);
        }
        if (approvalRequestFromTask.resolved) {
          throw new A2AError(A2AErrorKind.ApprovalIdAlreadyResolved);
        }
      }

      if (task.history.length === 0) {
        // Internal error. This is not user's fault, but db data inconsistency.
        throw new Error(
          "[A2AManager] No messages found in context for approval decisions",
        );
      }
      const lastMessage = task.history[task.history.length - 1];

      const lastMessageContent: UIMessage = lastMessage.content as UIMessage;
      const approvalRequestsFromUiMessage: A2AArchestraApprovalRequest[] =
        extractApprovalRequestsFromUiMessage(lastMessageContent);

      if (
        !areApprovalRequestsConsistent({
          primary: task.approvalRequests,
          secondary: approvalRequestsFromUiMessage,
        })
      ) {
        // Internal error. This is not user's fault, but db data inconsistency.
        throw new Error(
          "[A2AManager] Approval requests in task and in the last message are inconsistent",
        );
      }

      // UIMessage content will be mutated
      applyApprovalDecisionsToUiMessage({
        message: lastMessageContent,
        approvalDecisions,
      });
      // Apply to messages to db first
      await A2AMessageModel.updateContent(lastMessage.id, lastMessageContent);
      // Apply to task db
      task = await A2ATaskManager.updateTaskApprovalDecisions({
        task,
        approvalDecisions,
      });

      const hasPendingApprovalRequests = task.approvalRequests.some(
        (r) => !r.resolved,
      );
      if (!hasPendingApprovalRequests) {
        task = await A2ATaskManager.updateTaskState(
          task,
          A2AProtocolTaskState.Working,
        );
        task = await A2ATaskManager.removeTaskApprovalRequests(task);
        return {
          task,
          switchedToWorkingState: true,
          approvalDecisionsWasApplied: true,
        };
      }

      return { task, approvalDecisionsWasApplied: true };
    }

    return { task };
  }

  public async getTask(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolGetTaskRequest;
  }): Promise<A2AProtocolTask> {
    const { task } = await A2ATaskManager.findAndValidateTaskWithContext(
      params.request.id,
      undefined,
      params.actor,
    );
    if (!task) {
      throw new A2AError(A2AErrorKind.TaskNotFound);
    }
    return A2ATaskManager.toProtocolTask(task);
  }

  public async resolveActorByMCPGatewayToken(
    agentId: string,
    token: string,
  ): Promise<A2AActor> {
    const tokenAuth = await validateMCPGatewayToken(agentId, token);
    if (!tokenAuth) {
      throw new A2AError(A2AErrorKind.InvalidToken);
    }

    const organizationId = tokenAuth.organizationId;

    if (tokenAuth.userId) {
      const user = await UserModel.getById(tokenAuth.userId);
      if (!user) {
        throw new A2AError(A2AErrorKind.UserNotFound);
      }

      return {
        id: user.id,
        kind: "user",
        organizationId,
      };
    } else if (tokenAuth.teamId) {
      const team = await TeamModel.findById(tokenAuth.teamId);
      if (!team) {
        throw new A2AError(A2AErrorKind.TeamNotFound);
      }
      return {
        id: tokenAuth.teamId,
        kind: "team",
        organizationId,
      };
    } else if (tokenAuth.isOrganizationToken) {
      return {
        id: tokenAuth.organizationId,
        kind: "organization",
        organizationId,
      };
    }

    return {
      id: "system",
      kind: "system",
      organizationId,
    };
  }
}

function extractProtocolPartsFromUIMessage(
  uiMessage: UIMessage,
): A2AProtocolPart[] {
  const protocolParts: A2AProtocolPart[] = [];
  const parts = uiMessage.parts;
  for (const part of parts) {
    if (part.type === "text") {
      protocolParts.push({ text: part.text });
    }
  }
  return protocolParts;
}

function extractApprovalRequestsFromUiMessage(
  uiMessage: UIMessage,
): A2AArchestraApprovalRequest[] {
  const approvalRequests: A2AArchestraApprovalRequest[] = [];
  // state & approval data are stored in parts, but not declared in the type
  const parts = uiMessage.parts as {
    approval: { id: string; approved: boolean };
    state: string;
    type: string;
    toolCallId: string;
    input?: unknown;
  }[];
  for (const part of parts) {
    if (
      (part.state ?? "").startsWith("approval-") &&
      part.approval?.id &&
      part.type.startsWith("tool-")
    ) {
      approvalRequests.push({
        approvalId: part.approval.id,
        toolCallId: part.toolCallId,
        toolName: part.type.substring("tool-".length),
        // The tool call's arguments, carried so approval prompts can describe
        // what the tool will do (and unwrap a `run_tool` dispatch to its real
        // target). Only an object input is meaningful here.
        toolInput:
          typeof part.input === "object" &&
          part.input !== null &&
          !Array.isArray(part.input)
            ? (part.input as Record<string, unknown>)
            : undefined,
        approved: Boolean(part.approval?.approved),
        resolved: part.state === "approval-responded",
      });
    }
  }
  return approvalRequests;
}

function applyApprovalDecisionsToUiMessage(params: {
  message: UIMessage;
  approvalDecisions: A2AArchestraTaskApprovalDecision[];
}) {
  const { message, approvalDecisions } = params;
  const approvalDecisionsMap: Record<
    string,
    { approvalId: string; approved: boolean }
  > = {};
  approvalDecisions.forEach((d) => {
    if (d.approvalId) {
      approvalDecisionsMap[d.approvalId] = {
        approvalId: d.approvalId,
        approved: d.approved,
      };
    }
  });

  const parts = message.parts as {
    approval: { id: string; approved: boolean };
    state: string;
    type: string;
  }[];
  parts.forEach((p) => {
    const approvalId = p.approval?.id;

    if (approvalId && approvalDecisionsMap[approvalId]) {
      const decision = approvalDecisionsMap[approvalId];
      if (p.state === "approval-requested") {
        p.state = "approval-responded";
        p.approval.approved = decision.approved;
      }
    }
  });
}

/**
 * Checks that approval requests are consistent:
 *   - All unresolved approval requests must match
 *   - Secondary must not have extra approval requests that are not in primary
 *   - All matched approvalIds must have the same approved/resolved status
 */
function areApprovalRequestsConsistent(params: {
  primary: A2AArchestraApprovalRequest[];
  secondary: A2AArchestraApprovalRequest[];
}): boolean {
  const { primary, secondary } = params;

  const primaryMap = getApprovalRequestsMap(primary);
  const secondaryMap = getApprovalRequestsMap(secondary);

  for (const s of secondary) {
    const p = primaryMap[s.approvalId];
    if (!p) {
      // Secondary has an approval request that is not in primary
      return false;
    }
    if (p.resolved !== s.resolved || p.approved !== s.approved) {
      return false;
    }
  }
  for (const p of primary) {
    const s = secondaryMap[p.approvalId];
    if (!p.resolved && !s) {
      // Primary has an unresolved approval request that is not in secondary
      return false;
    }
    if (s && (p.resolved !== s.resolved || p.approved !== s.approved)) {
      return false;
    }
  }
  return true;
}
