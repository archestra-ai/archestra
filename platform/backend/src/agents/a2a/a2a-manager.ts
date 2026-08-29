import { randomUUID } from "node:crypto";
import { coerceMalformedToolInputs } from "@archestra/shared";
import {
  convertToModelMessages,
  type FilePart,
  type ModelMessage,
  type TextPart,
  type TextUIPart,
  type UIMessage,
} from "ai";
import { z } from "zod";
import logger from "@/logging";
import {
  A2AArtifactModel,
  A2AMessageModel,
  A2APushNotificationConfigModel,
  A2ATaskModel,
  AgentModel,
  AgentTeamModel,
  TeamModel,
  UserModel,
} from "@/models";
import { RouteCategory, startActiveChatSpan } from "@/observability/tracing";
import { validateMCPGatewayToken } from "@/routes/mcp-gateway/utils";
import {
  resolveAgentDeployment,
  resumeBackgroundTask,
  runTaskInBackground,
} from "@/services/runners/pod-execution";
import type {
  A2AContext,
  A2AMessage,
  AgentRun,
  AgentRunCompletionTarget,
} from "@/types";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import {
  type OutboundUrlRejection,
  validateOutboundUrl,
} from "@/utils/outbound-url";
import type { InteractionSource } from "../../../../shared";
import {
  type A2AAttachment,
  type A2AExecuteResult,
  executeA2AMessage,
} from "../a2a-executor";
import { type A2AActor, A2AError, A2AErrorKind } from "./a2a-base";
import {
  type A2AContextCompactionEvent,
  applyA2AContextCompaction,
} from "./a2a-context-compaction";
import {
  A2AContextManager,
  A2ATaskManager,
  type A2ATaskWithData,
  getApprovalRequestsMap,
} from "./a2a-model-manager";
import {
  type A2AArchestraApprovalRequest,
  A2AArchestraApprovalRequestSchema,
  type A2AArchestraTaskApprovalDecision,
  type A2AArchestraTaskOps,
  type A2AProtocolCancelTaskRequest,
  type A2AProtocolDeleteTaskPushNotificationConfigRequest,
  type A2AProtocolGetTaskPushNotificationConfigRequest,
  type A2AProtocolGetTaskRequest,
  type A2AProtocolListTaskPushNotificationConfigsRequest,
  type A2AProtocolListTaskPushNotificationConfigsResponse,
  type A2AProtocolListTasksRequest,
  type A2AProtocolListTasksResponse,
  type A2AProtocolMessage,
  type A2AProtocolPart,
  A2AProtocolRole,
  type A2AProtocolSendMessageRequest,
  type A2AProtocolSendMessageResponse,
  type A2AProtocolStreamResponse,
  type A2AProtocolSubscribeToTaskRequest,
  type A2AProtocolTask,
  type A2AProtocolTaskPushNotificationConfig,
  A2AProtocolTaskState,
} from "./a2a-protocol";
import { a2aTaskRunService } from "./a2a-task-run-service";

/** Wire name of the single text artifact carrying a tasked run's answer. */
const RESPONSE_ARTIFACT_NAME = "agent-response";

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

  /**
   * Skip the actor-ownership check when resolving contexts and tasks.
   *
   * Only for trusted internal callers that authorize access themselves: the
   * chatops manager verifies channel membership and agent access before every
   * execution, and its server-side sessions share one context per chat thread
   * across all participants (e.g. a Telegram group), so the per-actor
   * ownership model does not apply.
   *
   * Default: false (= contexts/tasks are actor-owned)
   */
  trustedContextAccess?: boolean;

  /**
   * How much of the A2A task lifecycle this manager drives.
   *
   * - "approval-only" (default): tasks exist purely as approval handles —
   *   the pre-existing behavior every internal consumer (chatops) is built
   *   on. Plain sends return `{message}`; no run detachment, no events.
   * - "full": the v2 protocol surface. Streaming and `returnImmediately`
   *   sends create durable tasks whose runs are registered with the task run
   *   service (delta events, artifacts, heartbeats, cancellation), terminal
   *   failures persist as TASK_STATE_FAILED, and spec guards apply (messages
   *   to terminal or already-running tasks are rejected). Requires stateful
   *   mode.
   */
  taskMode?: "full" | "approval-only";
}

/**
 * Out-of-band execution parameters passed through to `executeA2AMessage`.
 *
 * Named (rather than inlined on `sendMessage`) so callers that build it as an
 * intermediate `const` can annotate it: TypeScript only applies
 * excess-property checking to object literals assigned directly to a typed
 * target, so an unannotated intermediate silently swallows a misspelled key.
 * That is not hypothetical — chatops passed `route:` for a while and every
 * ChatOps run was traced as `a2a` because nothing reads that key.
 */
export interface A2ASystemParams {
  sessionId?: string;
  source?: InteractionSource;
  routeCategory?: RouteCategory;
  completionTarget?: AgentRunCompletionTarget;
  /**
   * Interactive is reserved for a person opening the execution terminal in
   * Chat. Every other durable task is one-shot so delegation surfaces can
   * receive a terminal result without waiting for somebody to exit a TUI.
   */
  backgroundExecutionMode?: "interactive" | "one_shot";
  /**
   * Per-turn framing prepended to the executed user turn but NOT
   * persisted with it. Callers with server-side sessions (chatops) put
   * situational context here — "(Telegram conversation, thread id: …)",
   * group framing — so the stored history stays clean instead of
   * repeating the frame on every persisted turn.
   */
  ephemeralExecutionPrefix?: string;
}

/**
 * How a full-task-mode send executes its run.
 * - "blocking": awaited; the response carries the settled outcome.
 * - "detached": the task handle returns immediately and the run continues in
 *   the background (`returnImmediately`, SendStreamingMessage).
 */
interface A2ATaskRunRequest {
  createTask: boolean;
  detached: boolean;
}

export class A2AManager {
  private readonly config: A2AManagerConfig;

  constructor(config?: A2AManagerConfig) {
    this.config = config ?? {};
  }

  /**
   * Re-adopt a container-backed task whose Job outlived the backend process
   * that launched it. The ordinary lifecycle remains authoritative, so the
   * recovered run produces the same artifact and terminal events as a run
   * that never crossed a restart.
   */
  public async adoptBackgroundTask(params: {
    taskId: string;
    session: AgentRun;
  }): Promise<void> {
    if (this.config.taskMode !== "full") {
      throw new Error(
        "[A2AManager] Background task adoption requires full mode",
      );
    }
    const task = await A2ATaskManager.loadTaskWithDataById(params.taskId);
    if (
      task.state !== A2AProtocolTaskState.Submitted &&
      task.state !== A2AProtocolTaskState.Working
    ) {
      return;
    }
    await this.runTaskLifecycle({
      task,
      contextId: task.contextId,
      survivesRestart: true,
      executeRun: (runOpts) =>
        resumeBackgroundTask({
          session: params.session,
          onTextDelta: runOpts.onTextDelta,
          abortSignal: runOpts.abortSignal,
        }),
    });
  }

  public async sendMessage(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolSendMessageRequest;
    // systemParams are currently used for passing through to executeA2AMessage(...)
    systemParams?: A2ASystemParams;
    /**
     * Fired when loading the context's history triggered a persisted
     * cross-turn compaction (stateful mode only), before the agent executes.
     * Chatops uses it to tell the user their conversation was summarized.
     */
    onContextCompacted?: (
      event: A2AContextCompactionEvent,
    ) => void | Promise<void>;
    /**
     * When provided (SendStreamingMessage), forwarded to the executor so each
     * incremental text delta is surfaced to the streaming caller. The buffered
     * response returned here is unchanged and remains authoritative.
     */
    onTextDelta?: (delta: string) => void;
    /**
     * Cancellation signal forwarded into the agent run (approval-only mode:
     * chatops aborts a muted thread's in-flight model requests). Full-mode
     * tasked runs ignore it — their lifetime is owned by the task run
     * service, so a caller disconnect no longer cancels the run.
     */
    abortSignal?: AbortSignal;
    /**
     * Full task mode only: create a task for this send and run it blocking or
     * detached. Ignored (with a warning) in approval-only mode.
     */
    taskRun?: A2ATaskRunRequest;
    /**
     * Fired just before a detached task run's snapshot is returned:
     * `followFromSeq` is the event-log watermark the caller should stream
     * events after — 0 for a freshly created task (nothing emitted yet), the
     * pre-resume watermark for a resumed one (so the resume's Working event
     * is delivered but earlier history is not replayed).
     */
    onDetachedTaskRun?: (info: {
      taskId: string;
      followFromSeq: number;
    }) => void | Promise<void>;
  }): Promise<A2AProtocolSendMessageResponse> {
    // Set once an approval resume has CAS'd the task to WORKING: if anything
    // between that point and the run lifecycle taking ownership throws
    // (history load, compaction, team lookup), the catch below settles the
    // task to FAILED instead of stranding a heartbeat-less WORKING task
    // until the reaper fires.
    let resumedWorkingTask: { taskId: string; contextId: string } | null = null;
    try {
      const { actor, agentId, request, systemParams, abortSignal } = params;
      const fullTaskMode = this.config.taskMode === "full";

      const [a2aUser, agent] = await Promise.all([
        actor.kind === "user" && actor.id !== "system"
          ? UserModel.getById(actor.id)
          : null,
        AgentModel.findById(agentId),
      ]);
      if (!agent) {
        throw new A2AError(A2AErrorKind.AgentNotFound);
      }

      const contextAccessOptions = {
        trustedActorAccess: Boolean(this.config.trustedContextAccess),
      };
      let task: A2ATaskWithData | undefined;
      let context: A2AContext | undefined;
      // Event-log watermark captured BEFORE any task op runs, so a detached
      // caller following the stream sees everything this send causes (starting
      // with the resume's Working event) and nothing from before it.
      let resumeWatermark = 0;
      if (request.message.taskId) {
        const { task: fetchedTask, context: fetchedContext } =
          await A2ATaskManager.findAndValidateTaskWithContext(
            request.message.taskId,
            undefined,
            actor,
            contextAccessOptions,
          );
        task = fetchedTask;
        context = fetchedContext;
        resumeWatermark = fetchedTask.nextEventSeq - 1;
        if (
          fullTaskMode &&
          fetchedTask.agentId &&
          fetchedTask.agentId !== agentId
        ) {
          throw new A2AError(A2AErrorKind.TaskNotFound);
        }
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
          contextAccessOptions,
        );
      }

      // Spec guards (A2A v1.0, full mode only to keep chatops semantics
      // untouched): terminal tasks are absorbing, and our execution model is
      // single-writer-per-task — the only joinable state is INPUT_REQUIRED
      // (approval resume), so a send addressed to a SUBMITTED/WORKING task is
      // rejected rather than racing the live run.
      if (fullTaskMode && task) {
        if (isTerminalA2ATaskState(task.state)) {
          throw new A2AError(
            A2AErrorKind.UnsupportedOperation,
            "the task is in a terminal state; start a new task in the same context instead",
          );
        }
        if (task.state !== A2AProtocolTaskState.InputRequired) {
          throw new A2AError(
            A2AErrorKind.UnsupportedOperation,
            "the task is still running; wait for it to reach an input-required or terminal state",
          );
        }
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
          if (fullTaskMode && switchedToWorkingState) {
            resumedWorkingTask = { taskId: task.id, contextId: task.contextId };
          }
        }
      }

      const messageParts: (TextPart | FilePart)[] = [];
      (request.message.parts || []).forEach((p) => {
        // Blank text carries no turn: the executor only builds a current user
        // turn from text that survives `trim()`, so keeping it would let
        // `needToExecute` pass and send the prior context — which ends with an
        // assistant turn — as the whole request. Blank text falls through to
        // the file branch rather than returning, so a part carrying both keeps
        // its payload.
        if (p.text !== undefined && p.text.trim() !== "") {
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
      let contextDbMessages =
        !this.config.stateless && context
          ? await A2AContextManager.getContextMessagesWithOverrides({
              context,
              override: task?.history || [],
            })
          : task && taskWasSwitchedToWorkingState
            ? task.history
            : [];

      // Stateful contexts accumulate history forever; apply the persisted
      // cross-turn compaction (and create a new one when the history crosses
      // the model-window threshold) before building the request.
      if (!this.config.stateless && context && contextDbMessages.length > 0) {
        const compactionResult = await applyA2AContextCompaction({
          contextId: context.id,
          messages: contextDbMessages,
          agent: {
            id: agent.id,
            llmApiKeyId: agent.llmApiKeyId,
            modelId: agent.modelId,
            organizationId: agent.organizationId,
          },
          userId: actor.kind === "user" ? actor.id : null,
          sessionId: systemParams?.sessionId,
          abortSignal,
        });
        contextDbMessages = compactionResult.messages;
        if (compactionResult.created) {
          await params.onContextCompacted?.(compactionResult.created);
        }
      }
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
      // Ephemeral framing rides only the executed turn; the persisted user
      // message and the mirrored UI turn below keep the caller's raw text.
      const executedTurnText =
        systemParams?.ephemeralExecutionPrefix && messageParts.length > 0
          ? `${systemParams.ephemeralExecutionPrefix}\n\n${currentTurnText}`
          : currentTurnText;

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

      let userMessageSavedInDb = false;
      /** Returns the db row when the turn was persisted at context level (no task yet). */
      const saveUserMessageInDb = async (): Promise<A2AMessage | null> => {
        if (userMessageSavedInDb) {
          return null;
        }
        userMessageSavedInDb = true;
        if (messageParts.length === 0) {
          return null;
        }
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
          const { task: updatedTask } = await A2ATaskManager.addMessageToTask({
            task,
            message: request.message,
            uiMessage: userUiMessage,
          });
          task = updatedTask;
          return null;
        }
        const { dbMessage } = await A2AContextManager.addMessageToContext({
          context,
          message: request.message,
          uiMessage: userUiMessage,
        });
        return dbMessage;
      };

      // Stateful mode persists the user turn BEFORE execution: an aborted run
      // (e.g. superseded by the sender's follow-up message) must still leave
      // its turn in the thread's history so the successor run sees it. When
      // the run later creates an approval task, this row is re-parented into
      // the task's history.
      let persistedContextUserMessage: A2AMessage | null = null;
      if (!this.config.stateless) {
        if (!context) {
          context = await A2AContextManager.createContext(actor);
        }
        persistedContextUserMessage = await saveUserMessageInDb();
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
      // Background execution belongs to the Agent itself and is selected only
      // for a durable task. Invocation surfaces decide whether a plain send
      // should remain a Message or be promoted to that task lifecycle.
      const deployment = resolveAgentDeployment(agent);

      const executeRun = (runOpts: {
        abortSignal?: AbortSignal;
        onTextDelta?: (delta: string) => void;
        /** Present only under the task lifecycle; a plain send has no task. */
        taskId?: string;
      }) =>
        startActiveChatSpan({
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
            // Only a task run goes to the container. This keeps the runtime
            // decision independent from the protocol surface: A2A can promote
            // a direct send, while foreground Chat can remain message-based.
            if (deployment && runOpts.taskId) {
              return runTaskInBackground({
                deployment,
                // The task is the pod's identity: one session per task, so a
                // resumed task adopts its own pod rather than starting a second.
                taskId: runOpts.taskId,
                agentId,
                actor,
                organizationId: actor.organizationId,
                completionTarget: systemParams?.completionTarget,
                task: executedTurnText,
                modelId: agent.modelId,
                llmApiKeyId: agent.llmApiKeyId,
                executionMode:
                  systemParams?.backgroundExecutionMode ?? "one_shot",
                titleUserId: actor.kind === "user" ? actor.id : undefined,
                onTextDelta: runOpts.onTextDelta,
                abortSignal: runOpts.abortSignal,
              });
            }
            return executeA2AMessage({
              agentId,
              message: executedTurnText,
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
              chatOpsBindingId:
                systemParams?.completionTarget?.type === "chatops"
                  ? systemParams.completionTarget.bindingId
                  : undefined,
              chatOpsThreadId:
                systemParams?.completionTarget?.type === "chatops"
                  ? systemParams.completionTarget.threadId
                  : undefined,
              onTextDelta: runOpts.onTextDelta,
              abortSignal: runOpts.abortSignal,
            });
          },
        });

      // ---- Full task mode: run under the durable task lifecycle -----------
      // A tasked run is requested explicitly (streaming / returnImmediately)
      // or implied by resuming an existing task. Everything below this block
      // is the pre-existing message-response flow, untouched for
      // approval-only managers and plain blocking sends.
      const taskRunRequested =
        fullTaskMode && (params.taskRun?.createTask || Boolean(task));
      if (taskRunRequested) {
        if (this.config.stateless) {
          throw new Error("[A2AManager] Full task mode requires stateful mode");
        }
        if (!context) {
          // This should never happen: stateful mode created the context above.
          throw new Error("[A2AManager] No context for a task run");
        }
        // `context` is a mutable binding; capture the id so the narrowing
        // survives into the lifecycle closure.
        const runContextId = context.id;

        let runTask: A2ATaskWithData;
        if (task) {
          runTask = task;
        } else {
          const created = await A2ATaskModel.createForRun({
            contextId: context.id,
            agentId,
            userMessageId: persistedContextUserMessage?.id,
          });
          runTask = {
            ...created,
            approvalRequests: [],
            history: persistedContextUserMessage
              ? [{ ...persistedContextUserMessage, taskId: created.id }]
              : [],
            artifacts: [],
          };
        }

        const lifecycle = () =>
          this.runTaskLifecycle({
            task: runTask,
            contextId: runContextId,
            executeRun,
            survivesRestart: Boolean(deployment),
          });

        if (params.taskRun?.detached) {
          const snapshot = A2ATaskManager.toProtocolTask(runTask);
          await params.onDetachedTaskRun?.({
            taskId: runTask.id,
            followFromSeq: task ? resumeWatermark : 0,
          });
          // Never-rejecting detached continuation: the lifecycle persists its
          // own terminal outcome; an escaping rejection here would take the
          // process down under the unhandled-rejection policy.
          void lifecycle().catch((error) => {
            logger.error(
              { error, taskId: runTask.id, agentId },
              "[A2AManager] Detached A2A task run crashed",
            );
          });
          return { task: snapshot };
        }

        return await lifecycle();
      }

      const result = await executeRun({
        abortSignal,
        onTextDelta: params.onTextDelta,
      });

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
            agentId,
            options: contextAccessOptions,
          });

          // The stateful pre-persist stored the triggering user turn on the
          // context before this task existed; re-parent it so the protocol
          // task history carries it (as it does in the stateless flow).
          if (persistedContextUserMessage) {
            const attached = await A2AMessageModel.assignTask(
              persistedContextUserMessage.id,
              task.id,
            );
            if (attached) {
              task = { ...task, history: [attached, ...task.history] };
            }
          }
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
      // A resumed task is WORKING but its run may never have started; settle
      // it so pollers see a terminal outcome. If the run's own lifecycle
      // already settled it (or a cancel won), this CAS is a no-op.
      if (resumedWorkingTask) {
        await this.settleFailedRun({
          taskId: resumedWorkingTask.taskId,
          contextId: resumedWorkingTask.contextId,
          statusReason: error instanceof Error ? error.message : String(error),
        }).catch((settleError) => {
          logger.error(
            { settleError, taskId: resumedWorkingTask?.taskId },
            "[A2AManager] Failed to settle a resumed task after a send error",
          );
        });
      }

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
   * Run one execution under the durable task lifecycle (full task mode):
   * start transition, delta events + artifact chunks through the run
   * service, and exactly one terminal/interrupt transaction — COMPLETED,
   * INPUT_REQUIRED (approvals), CANCELED, or FAILED. The task row is the
   * authority at every step: every transition is a CAS, so whichever of
   * {this run, CancelTask, the reaper} settles the task first wins and the
   * others observe it.
   */
  private async runTaskLifecycle(params: {
    task: A2ATaskWithData;
    contextId: string;
    executeRun: (runOpts: {
      abortSignal?: AbortSignal;
      onTextDelta?: (delta: string) => void;
      taskId?: string;
    }) => Promise<A2AExecuteResult>;
    /** This task's work runs in a container, so it outlives this process. */
    survivesRestart?: boolean;
  }): Promise<A2AProtocolSendMessageResponse> {
    const { contextId } = params;
    let task = params.task;
    const taskId = task.id;

    // A resumed run continues the task's existing response artifact instead
    // of minting a second one — a task carries exactly one `agent-response`
    // artifact across approval interrupts.
    const existingArtifact = (await A2AArtifactModel.findByTaskId(taskId)).find(
      (artifact) => artifact.name === RESPONSE_ARTIFACT_NAME,
    );
    const artifactId = existingArtifact?.id ?? randomUUID();

    // Fresh liveness signal before anything else: a task resumed long after
    // its interrupt still holds the pre-interrupt heartbeat, which would
    // otherwise make it instantly reapable as an orphan.
    await A2ATaskModel.touchHeartbeat(taskId);

    // Start transition. A freshly created task starts from SUBMITTED; a task
    // being fed new input starts from INPUT_REQUIRED. An approval resume
    // already flipped to WORKING (with its event) inside the resume
    // transaction, so there is nothing to do. A CAS miss means the task was
    // canceled between creation/validation and here.
    if (task.state !== A2AProtocolTaskState.Working) {
      const workingEvent: A2AProtocolStreamResponse = {
        statusUpdate: {
          taskId,
          contextId,
          status: { state: A2AProtocolTaskState.Working },
        },
      };
      const started = await A2ATaskModel.transitionStateWithEvent({
        id: taskId,
        to: A2AProtocolTaskState.Working,
        allowedFrom: [
          A2AProtocolTaskState.Submitted,
          A2AProtocolTaskState.InputRequired,
        ],
        eventPayload: workingEvent,
      });
      if (!started) {
        const refreshed = await A2ATaskManager.loadTaskWithDataById(taskId);
        return { task: A2ATaskManager.toProtocolTask(refreshed) };
      }
      task = { ...task, ...started };
      a2aTaskRunService.notify(taskId, workingEvent);
    }

    let isFirstChunk = true;
    const run = a2aTaskRunService.startRun({
      taskId,
      survivesRestart: params.survivesRestart,
      artifact: { id: artifactId, name: RESPONSE_ARTIFACT_NAME },
      buildDeltaEvent: (chunk) => {
        const append = !isFirstChunk;
        isFirstChunk = false;
        return {
          artifactUpdate: {
            taskId,
            contextId,
            artifact: {
              artifactId,
              name: RESPONSE_ARTIFACT_NAME,
              parts: [{ text: chunk }],
            },
            ...(append ? { append: true } : {}),
          },
        };
      },
    });

    try {
      const result = await params.executeRun({
        abortSignal: run.signal,
        onTextDelta: run.onTextDelta,
        taskId,
      });
      await run.drainDeltas();

      const approvalRequests = extractApprovalRequestsFromUiMessage(
        result.responseUiMessage,
      );
      const parts = extractProtocolPartsFromUIMessage(result.responseUiMessage);
      const agentMessage = {
        id: result.responseUiMessage.id,
        contextId,
        role: A2AProtocolRole.Agent,
        parts,
        content: result.responseUiMessage,
      };

      if (approvalRequests.length > 0) {
        if (this.config.disableApprovalFlow) {
          await this.settleFailedRun({
            taskId,
            contextId,
            statusReason:
              "The agent requested tool approval, but the approval flow is disabled.",
          });
          throw new A2AError(A2AErrorKind.OutputApprovalFlowIsDisabled);
        }

        const sortedRequests = [...approvalRequests].sort((a, b) =>
          a.approvalId.localeCompare(b.approvalId),
        );
        const interruptEvent: A2AProtocolStreamResponse = {
          statusUpdate: {
            taskId,
            contextId,
            status: { state: A2AProtocolTaskState.InputRequired },
          },
        };
        await A2ATaskModel.interruptForApproval({
          taskId,
          agentMessage,
          approvalRequests: sortedRequests.map((request) => ({
            taskId,
            approvalId: request.approvalId,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            approved: request.approved,
            resolved: request.resolved,
          })),
          eventPayload: interruptEvent,
        });
        a2aTaskRunService.notify(taskId, interruptEvent);
        // A CAS miss here means a cancellation landed while the run was
        // interrupting — the refreshed task carries whichever outcome won.
        const refreshed = await A2ATaskManager.loadTaskWithDataById(taskId);
        return { task: A2ATaskManager.toProtocolTask(refreshed) };
      }

      // Seal from the authoritative response message (which spans an
      // approval interrupt), not `result.text` (this run's generation only).
      const completedEvent: A2AProtocolStreamResponse = {
        statusUpdate: {
          taskId,
          contextId,
          status: {
            state: A2AProtocolTaskState.Completed,
            message: {
              messageId: result.responseUiMessage.id,
              contextId,
              taskId,
              role: A2AProtocolRole.Agent,
              parts,
            },
          },
        },
      };
      const finalParts: { text: string }[] = [
        { text: parts.map((part) => part.text ?? "").join("") },
      ];
      await A2ATaskModel.completeRun({
        taskId,
        agentMessage,
        artifact: {
          id: artifactId,
          name: RESPONSE_ARTIFACT_NAME,
          parts: finalParts,
        },
        eventPayloads: [
          {
            // Seal the artifact: replace-with-final-content + lastChunk, so
            // event-following clients hold the authoritative artifact even if
            // a delta batch was reordered away by a crash.
            artifactUpdate: {
              taskId,
              contextId,
              artifact: {
                artifactId,
                name: RESPONSE_ARTIFACT_NAME,
                parts: finalParts,
              },
              lastChunk: true,
            },
          },
          completedEvent,
        ],
      });
      a2aTaskRunService.notify(taskId, completedEvent);

      // CAS miss = cancellation won while the run was completing: the
      // completion transaction rolled back, and the task stays CANCELED with
      // no completed outputs.
      const refreshed = await A2ATaskManager.loadTaskWithDataById(taskId);
      return { task: A2ATaskManager.toProtocolTask(refreshed) };
    } catch (error) {
      // EVERY escape path settles the task (a CAS no-op when something —
      // cancellation, the disableApprovalFlow settle above — already did).
      // Outcome decided BEFORE persistence (an abort is a cancellation, not a
      // failure), and the terminal write must never mask the original error.
      const wasAborted = run.signal.aborted;
      const reason = error instanceof Error ? error.message : String(error);
      try {
        if (wasAborted) {
          await A2ATaskModel.transitionStateWithEvent({
            id: taskId,
            to: A2AProtocolTaskState.Canceled,
            allowedFrom: [
              A2AProtocolTaskState.Submitted,
              A2AProtocolTaskState.Working,
            ],
            statusReason: "The task run was aborted.",
            clearApprovals: true,
            eventPayload: {
              statusUpdate: {
                taskId,
                contextId,
                status: {
                  state: A2AProtocolTaskState.Canceled,
                  message: buildStatusReasonMessage({
                    taskId,
                    contextId,
                    reason: "The task run was aborted.",
                  }),
                },
              },
            },
          });
          // Terminal state and its event committed together; let parked
          // subscribers read the cancellation now.
          a2aTaskRunService.wakeSubscribers(taskId);
        } else {
          await this.settleFailedRun({
            taskId,
            contextId,
            statusReason: reason,
          });
        }
      } catch (persistError) {
        logger.error(
          { persistError, taskId },
          "[A2AManager] Failed to persist the terminal state of an A2A task run; the reaper will settle it",
        );
      }

      throw error;
    } finally {
      run.finish();
    }
  }

  /** CAS the task to FAILED with its terminal event; no-op if already settled. */
  private async settleFailedRun(params: {
    taskId: string;
    contextId: string;
    statusReason: string;
  }): Promise<void> {
    await A2ATaskModel.transitionStateWithEvent({
      id: params.taskId,
      to: A2AProtocolTaskState.Failed,
      allowedFrom: [
        A2AProtocolTaskState.Submitted,
        A2AProtocolTaskState.Working,
      ],
      statusReason: params.statusReason,
      eventPayload: {
        statusUpdate: {
          taskId: params.taskId,
          contextId: params.contextId,
          status: {
            state: A2AProtocolTaskState.Failed,
            // Stream followers get the same diagnostics GetTask serves.
            message: buildStatusReasonMessage({
              taskId: params.taskId,
              contextId: params.contextId,
              reason: params.statusReason,
            }),
          },
        },
      },
    });

    // Inside the helper rather than at its call sites: a failure can settle a
    // task from several escape paths, and a parked subscriber must learn about
    // every one of them without waiting out its fallback interval.
    a2aTaskRunService.wakeSubscribers(params.taskId);
  }

  /**
   * Resolve a task for this route's agent + actor. Tasks bound to a different
   * agent answer TaskNotFound (existence non-disclosure); rows with no
   * binding (pre-binding tasks, tasks whose agent was deleted) fall back to
   * the actor/context ownership check alone. That fallback is deliberately
   * actor-scoped, not open: reaching such a task through another agent still
   * requires a gateway token valid for THAT agent plus ownership of the
   * task's context, so no other actor ever gains access — the only latitude
   * is which of their own agent endpoints the owner may use.
   */
  private async findTaskForAgent(params: {
    taskId: string;
    actor: A2AActor;
    agentId: string;
  }): Promise<A2ATaskWithData> {
    let task: A2ATaskWithData;
    try {
      ({ task } = await A2ATaskManager.findAndValidateTaskWithContext(
        params.taskId,
        undefined,
        params.actor,
        { trustedActorAccess: Boolean(this.config.trustedContextAccess) },
      ));
    } catch (error) {
      // Existence non-disclosure: another actor's task must answer exactly
      // like an unknown one, not with the distinguishable context error.
      if (
        error instanceof A2AError &&
        error.kind === A2AErrorKind.ContextNotFound
      ) {
        throw new A2AError(A2AErrorKind.TaskNotFound);
      }
      throw error;
    }
    if (task.agentId && task.agentId !== params.agentId) {
      throw new A2AError(A2AErrorKind.TaskNotFound);
    }
    return task;
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

      // The model applies the decisions, re-derives the message content from
      // its FRESH database state, and resumes the task in the same
      // transaction when the last pending decision lands. Deciding
      // partial-vs-resume there (under the task's row lock, not from this
      // method's snapshot) is what keeps two concurrent decisions on
      // different approvals from both taking the partial path and stranding
      // a fully-resolved task in INPUT_REQUIRED.
      const result = await A2ATaskModel.applyApprovalDecisionsAndMaybeResume({
        taskId: task.id,
        lastMessageId: lastMessage.id,
        approvalDecisions: approvalDecisions.map((d) => ({
          approvalId: d.approvalId,
          approved: d.approved,
        })),
        applyDecisionsToContent: (freshContent) => {
          const message = (freshContent ?? lastMessageContent) as UIMessage;
          applyApprovalDecisionsToUiMessage({ message, approvalDecisions });
          return message;
        },
        resumeEventPayload: {
          statusUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            status: { state: A2AProtocolTaskState.Working },
          },
        },
      });

      if (!("task" in result)) {
        if (result.outcome === "task_not_input_required") {
          throw new A2AError(
            A2AErrorKind.TaskIsNotInputRequired,
            "the task was resumed or canceled concurrently",
          );
        }
        throw new A2AError(A2AErrorKind.ApprovalIdAlreadyResolved);
      }

      // Mirror the transaction's outcome into the in-memory task: fresh row,
      // fresh approval rows, and the content the transaction persisted.
      const refreshedHistory = [
        ...task.history.slice(0, -1),
        { ...lastMessage, content: result.content },
      ];
      const refreshedApprovals = z
        .array(A2AArchestraApprovalRequestSchema)
        .parse(
          [...result.approvalRows].sort((a, b) =>
            a.approvalId.localeCompare(b.approvalId),
          ),
        );
      task = {
        ...task,
        ...result.task,
        history: refreshedHistory,
        approvalRequests:
          result.outcome === "resumed" ? [] : refreshedApprovals,
      };

      return {
        task,
        switchedToWorkingState: result.outcome === "resumed",
        approvalDecisionsWasApplied: true,
      };
    }

    return { task };
  }

  public async getTask(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolGetTaskRequest;
  }): Promise<A2AProtocolTask> {
    const task = await this.findTaskForAgent({
      taskId: params.request.id,
      actor: params.actor,
      agentId: params.agentId,
    });
    return A2ATaskManager.toProtocolTask(task, {
      historyLength: params.request.historyLength,
    });
  }

  /**
   * A2A `CancelTask`: durably CAS the task to CANCELED (with its terminal
   * event and approval cleanup) FIRST, then best-effort abort the run — a
   * non-cooperative run can then never overwrite the canceled outcome, and a
   * run on another pod observes the state via its own poll / append guard.
   */
  public async cancelTask(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolCancelTaskRequest;
  }): Promise<A2AProtocolTask> {
    const task = await this.findTaskForAgent({
      taskId: params.request.id,
      actor: params.actor,
      agentId: params.agentId,
    });

    if (isTerminalA2ATaskState(task.state)) {
      throw new A2AError(A2AErrorKind.TaskNotCancelable);
    }

    const canceled = await A2ATaskModel.transitionStateWithEvent({
      id: task.id,
      to: A2AProtocolTaskState.Canceled,
      allowedFrom: [
        A2AProtocolTaskState.Submitted,
        A2AProtocolTaskState.Working,
        A2AProtocolTaskState.InputRequired,
        A2AProtocolTaskState.AuthRequired,
        A2AProtocolTaskState.Unspecified,
      ],
      statusReason: "The task was canceled by the client.",
      clearApprovals: true,
      eventPayload: {
        statusUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          status: {
            state: A2AProtocolTaskState.Canceled,
            message: buildStatusReasonMessage({
              taskId: task.id,
              contextId: task.contextId,
              reason: "The task was canceled by the client.",
            }),
          },
        },
      },
    });
    if (!canceled) {
      // Lost the race to another terminal transition (concurrent cancel or a
      // completing run) — per spec a terminal task is not cancelable.
      throw new A2AError(A2AErrorKind.TaskNotCancelable);
    }

    a2aTaskRunService.abortLocal(task.id);
    // The canceled state and its terminal event committed together above, so
    // subscribers on every replica can read the cancellation now rather than
    // waiting out their fallback interval.
    a2aTaskRunService.wakeSubscribers(task.id);

    const refreshed = await A2ATaskManager.loadTaskWithData(canceled);
    return A2ATaskManager.toProtocolTask(refreshed);
  }

  /**
   * A2A `SubscribeToTask` validation + snapshot: returns the authorized task
   * (throwing -32004 when it is already terminal, per spec — finished work is
   * fetched with GetTask) together with the event-sequence watermark bound to
   * that snapshot. The transport layer polls `readTaskEventsAfter` from the
   * watermark, so no event can be duplicated or skipped between snapshot and
   * first poll.
   */
  public async subscribeToTask(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolSubscribeToTaskRequest;
  }): Promise<{ task: A2AProtocolTask; taskId: string; watermark: number }> {
    const task = await this.findTaskForAgent({
      taskId: params.request.id,
      actor: params.actor,
      agentId: params.agentId,
    });

    if (isTerminalA2ATaskState(task.state)) {
      throw new A2AError(
        A2AErrorKind.UnsupportedOperation,
        "the task is already in a terminal state; use GetTask to fetch it",
      );
    }

    // The snapshot must be consistent with the watermark: an event landing
    // between the watermark read and the snapshot assembly would either be
    // skipped (watermark after snapshot) or double-delivered on top of the
    // snapshot's artifact content (watermark before snapshot). Re-read the
    // allocator after assembling the snapshot and retry until it is stable —
    // with one writer per task and 250ms delta batching, a retry is rare.
    let snapshot = task;
    let watermark = task.nextEventSeq - 1;
    for (let attempt = 0; attempt < 5; attempt++) {
      const after = await A2ATaskModel.findById(snapshot.id);
      if (!after) {
        throw new A2AError(A2AErrorKind.TaskNotFound);
      }
      if (after.nextEventSeq - 1 === watermark) {
        return {
          task: A2ATaskManager.toProtocolTask(snapshot),
          taskId: snapshot.id,
          watermark,
        };
      }
      watermark = after.nextEventSeq - 1;
      snapshot = await A2ATaskManager.loadTaskWithData(after);
    }

    // Never hand out an unstable snapshot/watermark pair — a skipped or
    // double-applied artifact chunk is worse than asking the client to retry.
    throw new Error(
      `A2A task ${task.id} emitted events continuously during snapshot assembly; retry SubscribeToTask`,
    );
  }

  /**
   * Poll step for SubscribeToTask streams: the task's current state plus its
   * events strictly after `afterSeq`. Terminal state + drained events =
   * close the stream.
   */
  public async readTaskEventsAfter(params: {
    taskId: string;
    afterSeq: number;
  }): Promise<{
    state: A2AProtocolTaskState;
    events: { seq: number; payload: A2AProtocolStreamResponse }[];
  } | null> {
    const result = await A2ATaskModel.readTaskAndEventsAfter(params);
    if (!result) {
      return null;
    }
    return { state: result.task.state, events: result.events };
  }

  /**
   * A2A `CreateTaskPushNotificationConfig`. The URL is validated up front so a
   * caller learns about an unreachable or disallowed endpoint synchronously
   * rather than through silent non-delivery.
   */
  public async createTaskPushNotificationConfig(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolTaskPushNotificationConfig;
  }): Promise<A2AProtocolTaskPushNotificationConfig> {
    const task = await this.findTaskForAgent({
      taskId: params.request.taskId,
      actor: params.actor,
      agentId: params.agentId,
    });

    const { pushNotificationConfig: input } = params.request;
    const validated = validateOutboundUrl(input.url);
    if (!validated.ok) {
      throw new A2AError(
        A2AErrorKind.InvalidPushNotificationUrl,
        PUSH_URL_REJECTION_DETAIL[validated.reason],
      );
    }

    // A client that supplies an id is re-registering that config; keep the id
    // stable so repeated setup calls do not pile up duplicate webhooks.
    if (input.id) {
      const updated = await A2APushNotificationConfigModel.update({
        id: input.id,
        taskId: task.id,
        url: input.url,
        token: input.token,
        authScheme: input.authentication?.scheme,
        authCredentials: input.authentication?.credentials,
      });
      if (updated) {
        return toProtocolPushConfig(updated);
      }
    }

    const created = await A2APushNotificationConfigModel.create({
      taskId: task.id,
      url: input.url,
      token: input.token,
      authScheme: input.authentication?.scheme,
      authCredentials: input.authentication?.credentials,
    });
    return toProtocolPushConfig(created);
  }

  /** A2A `GetTaskPushNotificationConfig`. Credentials are never echoed back. */
  public async getTaskPushNotificationConfig(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolGetTaskPushNotificationConfigRequest;
  }): Promise<A2AProtocolTaskPushNotificationConfig> {
    const task = await this.findTaskForAgent({
      taskId: params.request.taskId,
      actor: params.actor,
      agentId: params.agentId,
    });

    const config = await A2APushNotificationConfigModel.findByIdForTask({
      id: params.request.id,
      taskId: task.id,
    });
    if (!config) {
      throw new A2AError(A2AErrorKind.PushNotificationConfigNotFound);
    }
    return toProtocolPushConfig(config);
  }

  /** A2A `ListTaskPushNotificationConfigs`. */
  public async listTaskPushNotificationConfigs(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolListTaskPushNotificationConfigsRequest;
  }): Promise<A2AProtocolListTaskPushNotificationConfigsResponse> {
    const task = await this.findTaskForAgent({
      taskId: params.request.taskId,
      actor: params.actor,
      agentId: params.agentId,
    });

    const configs = await A2APushNotificationConfigModel.findByTaskId(task.id);
    return { configs: configs.map(toProtocolPushConfig) };
  }

  /** A2A `DeleteTaskPushNotificationConfig`. */
  public async deleteTaskPushNotificationConfig(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolDeleteTaskPushNotificationConfigRequest;
  }): Promise<Record<string, never>> {
    const task = await this.findTaskForAgent({
      taskId: params.request.taskId,
      actor: params.actor,
      agentId: params.agentId,
    });

    const deleted = await A2APushNotificationConfigModel.delete({
      id: params.request.id,
      taskId: task.id,
    });
    if (!deleted) {
      throw new A2AError(A2AErrorKind.PushNotificationConfigNotFound);
    }
    return {};
  }

  /** A2A `ListTasks`, scoped to the calling actor and the route's agent. */
  public async listTasks(params: {
    actor: A2AActor;
    agentId: string;
    request: A2AProtocolListTasksRequest;
  }): Promise<A2AProtocolListTasksResponse> {
    const { request } = params;
    const pageSize = request.pageSize ?? 20;

    const cursor = request.pageToken
      ? decodeListTasksPageToken(request.pageToken)
      : undefined;

    const { tasks, totalSize } = await A2ATaskModel.listForActor({
      actorKind: params.actor.kind,
      actorId: params.actor.id,
      agentId: params.agentId,
      contextId: request.contextId,
      state: request.status,
      statusChangedAfter: request.statusTimestampAfter
        ? new Date(request.statusTimestampAfter)
        : undefined,
      cursor,
      pageSize,
    });

    const withData = await A2ATaskManager.loadTasksWithData(tasks);

    const last = tasks[tasks.length - 1];
    const nextPageToken =
      tasks.length === pageSize && last
        ? encodeListTasksPageToken({
            stateChangedAt: last.stateChangedAt ?? last.createdAt,
            id: last.id,
          })
        : "";

    return {
      tasks: withData.map((task) =>
        A2ATaskManager.toProtocolTask(task, {
          historyLength: request.historyLength ?? 0,
          includeArtifacts: request.includeArtifacts ?? false,
        }),
      ),
      nextPageToken,
      pageSize,
      totalSize,
    };
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

/**
 * Opaque, stable ListTasks cursor: the (status-change timestamp, id) pair of
 * the last row of the previous page, base64-encoded. Both components are
 * immutable once written (heartbeats touch a different column), so pages
 * never skip or duplicate under concurrent activity.
 */
function encodeListTasksPageToken(cursor: {
  stateChangedAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.stateChangedAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

function decodeListTasksPageToken(token: string): {
  stateChangedAt: Date;
  id: string;
} {
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString());
    const timestamp = new Date(decoded.t);
    if (
      Number.isNaN(timestamp.getTime()) ||
      // The id is cast to ::uuid in SQL — validate here so a malformed token
      // is a clean -32602 instead of a database error.
      !z.uuid().safeParse(decoded.id).success
    ) {
      throw new Error("malformed");
    }
    return { stateChangedAt: timestamp, id: decoded.id };
  } catch {
    throw new A2AError(A2AErrorKind.InvalidPageToken);
  }
}

/** Why a webhook URL was refused, phrased for the caller. */
const PUSH_URL_REJECTION_DETAIL: Record<OutboundUrlRejection, string> = {
  not_a_url: "the url is not a valid absolute URL",
  scheme_not_https: "the url must use https",
  private_or_loopback_host:
    "the url must not point at a private or loopback address",
};

/** Protocol shape of a stored config. Credentials are deliberately omitted. */
function toProtocolPushConfig(config: {
  id: string;
  taskId: string;
  url: string;
  token: string | null;
  authScheme: string | null;
}): A2AProtocolTaskPushNotificationConfig {
  return {
    taskId: config.taskId,
    pushNotificationConfig: {
      id: config.id,
      url: config.url,
      ...(config.token ? { token: config.token } : {}),
      ...(config.authScheme
        ? { authentication: { scheme: config.authScheme } }
        : {}),
    },
  };
}

/** TaskStatus.message carrying a terminal reason (same shape GetTask serves). */
function buildStatusReasonMessage(params: {
  taskId: string;
  contextId: string;
  reason: string;
}): A2AProtocolMessage {
  return {
    messageId: `${params.taskId}-status`,
    contextId: params.contextId,
    taskId: params.taskId,
    role: A2AProtocolRole.Agent,
    parts: [{ text: params.reason }],
  };
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
