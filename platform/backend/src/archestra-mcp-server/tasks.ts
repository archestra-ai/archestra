import path from "node:path";
import {
  DEFAULT_APP_NAME,
  TOOL_CANCEL_AGENT_RUN_SHORT_NAME,
  TOOL_DELETE_WORKSPACE_SHORT_NAME,
  TOOL_GET_AGENT_RUN_SHORT_NAME,
  TOOL_LIST_AGENT_RUNS_SHORT_NAME,
  TOOL_POST_AGENT_RUN_FILE_SHORT_NAME,
  TOOL_POST_AGENT_RUN_MESSAGE_SHORT_NAME,
  TOOL_READ_WORKSPACE_FILE_SHORT_NAME,
  TOOL_START_AGENT_RUN_SHORT_NAME,
  TOOL_STEER_AGENT_RUN_SHORT_NAME,
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
  TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type A2AActor, A2AError, A2AErrorKind } from "@/agents/a2a/a2a-base";
import type { A2AAttachment } from "@/agents/a2a-executor";
import { watchTaskCompletion } from "@/agents/task-completion-watcher";
import { userHasPermission } from "@/auth";
import { getAppAssetBaseOrigin } from "@/config";
import logger from "@/logging";
import {
  A2AArtifactModel,
  A2AMessageModel,
  A2ATaskModel,
  AgentModel,
  AgentRunModel,
  AgentTeamModel,
  AgentWorkspaceModel,
  InteractionModel,
} from "@/models";
import OpenAppaSpawnCorrelationModel from "@/models/openappa-spawn-correlation";
import { RouteCategory } from "@/observability/tracing";
import { AGENT_WORKSPACE_TRANSFER_PREFIX } from "@/routes/route-paths";
import {
  prepareAgentRuntimeBackendDriver,
  resolveAgentRuntimeBackendDriver,
} from "@/services/agent-runtime/backends";
import { preflightAgentRuntimeCredentials } from "@/services/agent-runtime/credentials";
import {
  pendingExports,
  pendingFileNotice,
} from "@/services/agent-runtime/pending-exports";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import {
  agentRunUrl,
  submittedRunNextStep,
} from "@/services/agent-runtime/run-handle";
import {
  admitRuntimeSteer,
  classifyRuntimeCaller,
  crossingRefusal,
  crossRuntimeOutput,
  guardRuntimeCrossing,
  NOT_A_SPAWN,
  type RuntimeCrossing,
  refuseUnrecognizedCaller,
  reportCrossingRefusal,
  SPAWN_TARGET_MISMATCH,
  UNVERIFIED_RUNTIME_SESSION,
} from "@/services/agent-runtime/runtime-crossing";
import {
  cancelDetachedAgentTask,
  startDetachedAgentTask,
} from "@/services/agent-runtime/start-task";
import { accessAgentWorkspaceFile } from "@/services/agent-runtime/workspace-files";
import { deleteAgentWorkspace } from "@/services/agent-runtime/workspace-lifecycle";
import {
  WORKSPACE_TRANSFER_TICKET_TTL_MS,
  workspaceTransferTickets,
} from "@/services/agent-runtime/workspace-transfers";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  AGENT_RUNTIME_CREDENTIALS_REQUIRED_CODE,
  AgentRunAttentionStateSchema,
  AgentWorkspaceStateSchema,
  ApiError,
} from "@/types";
import type { A2ATaskFailure } from "@/types/a2a-task";
import { agentRunAttachmentsSchema } from "@/types/agent-run-attachments";
import {
  type RuntimeLaunchFailureReason,
  type RuntimeLaunchOutcome,
  RuntimeLaunchStateSchema,
} from "@/types/openappa-runtime-launch";
import {
  agentCredentialSetupUrl,
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Start a durable delegated run through the same lifecycle used by the MCP
 * run tools. Agent delegation uses this when the target has Background run
 * configured, so every delegation surface selects the same runtime.
 */
export async function startDelegatedTask(params: {
  agentId: string;
  message: string;
  attachments?: A2AAttachment[];
  context: ArchestraContext;
}) {
  const { result, outcome } = await launchDelegatedTask(params);
  if (outcome) await recordRuntimeLaunch(params.context, outcome);
  return result;
}

async function launchDelegatedTask(params: {
  agentId: string;
  message: string;
  attachments?: A2AAttachment[];
  context: ArchestraContext;
}): Promise<{ result: CallToolResult; outcome?: RuntimeLaunchOutcome }> {
  const { agentId, message, context } = params;
  try {
    const actor = requireActor(context);
    const agent = await AgentModel.findById(agentId);
    if (!agent || agent.organizationId !== actor.organizationId) {
      return failedLaunch("agent_not_found", errorResult("Agent not found"));
    }
    const isAgentAdmin = await ResourcePermissions.allows({
      userId: actor.id,
      organizationId: actor.organizationId,
      resource: "agent",
      scope: "*",
      action: "update",
    });
    if (
      !(await AgentTeamModel.userHasAgentAccess({
        userId: actor.id,
        agentId: agent.id,
        isAgentAdmin: isAgentAdmin,
        agentAccessContext: agent,
        action: "use",
      }))
    ) {
      return failedLaunch("agent_not_found", errorResult("Agent not found"));
    }

    const runtime = resolveAgentRuntime(agent);
    if (!runtime) {
      return failedLaunch(
        "refused",
        errorResult(
          context.openappaRuntimeCall?.spawn
            ? SPAWN_TARGET_MISMATCH
            : `Agent "${agent.name}" has no Agent Runtime, so it cannot run in the background. Delegate to it with its agent tool instead.`,
        ),
      );
    }
    await prepareAgentRuntimeBackendDriver(runtime.backend);
    const crossing = await runtimeCrossingForStart(context);
    if (typeof crossing === "string") {
      return failedLaunch("refused", errorResult(crossing));
    }

    // Refuse before creating a task when the caller can already fix the
    // missing credential. Otherwise the detached task fails after its handle
    // has been returned and the user only discovers the problem by polling.
    const preflight = await preflightAgentRuntimeCredentials({
      runtime,
      organizationId: actor.organizationId,
      userId: actor.id,
    });
    if (preflight.missing.length > 0) {
      return credentialsNeededLaunch(agent.id, preflight.missing);
    }
    if (preflight.misconfigured.length > 0) {
      return failedLaunch(
        "credentials_misconfigured",
        errorResult(
          `Agent "${agent.name}" is missing shared Agent Runtime credentials an administrator must configure: ${preflight.misconfigured
            .map((entry) => entry.label)
            .join(", ")}`,
        ),
      );
    }

    const completionTarget =
      context.chatOpsBindingId && context.chatOpsThreadId
        ? {
            type: "chatops" as const,
            bindingId: context.chatOpsBindingId,
            threadId: context.chatOpsThreadId,
            ...(context.chatOpsPinnedAgentId && {
              pinnedAgentId: context.chatOpsPinnedAgentId,
            }),
          }
        : undefined;
    const taskRow = await startDetachedAgentTask({
      actor,
      agentId: agent.id,
      message,
      attachments: params.attachments,
      systemParams: {
        sessionId:
          context.sessionId || context.conversationId || context.isolationKey,
        routeCategory: completionTarget
          ? RouteCategory.CHATOPS
          : RouteCategory.A2A,
        completionTarget,
        ...(crossing ? { runtimeCrossing: crossing } : {}),
      },
    });

    // Work started from a chat thread reports back to that thread when it
    // settles. The callback coordinates are also persisted on the Agent run,
    // so the reconciler can recover delivery after a restart.
    if (completionTarget) {
      void watchTaskCompletion({
        taskId: taskRow.id,
        agentName: agent.name,
        target: completionTarget,
      }).catch((error) => {
        logger.warn(
          { error, taskId: taskRow.id },
          "Failed to watch Agent task for messaging-channel completion",
        );
      });
    }

    // The first turn's task id is the run's stable id (its workspace id).
    const run = runSummary({ row: taskRow, runId: taskRow.id });
    const state = RuntimeLaunchStateSchema.safeParse(run.state);
    const reportsToThread = completionTarget !== undefined;
    return {
      result: structuredSuccessResult({
        run,
        run_url: agentRunUrl(taskRow.id),
        next_step: submittedRunNextStep({ reportsToThread }),
      }),
      outcome: {
        kind: "launched",
        session_id: taskRow.id,
        ...(state.success ? { state: state.data } : {}),
        ...(reportsToThread ? { reports_to_thread: true as const } : {}),
      },
    };
  } catch (error) {
    const needed = missingCredentialsFrom(error);
    if (needed) {
      return credentialsNeededLaunch(needed.agentId, needed.missing);
    }
    const refused = crossingRefusal(error);
    if (refused) return failedLaunch("refused", errorResult(refused));
    return failedLaunch("failed", catchError(error, "starting the run"));
  }
}

/**
 * The MCP face of the Agent Runtime run lifecycle: start long-running work on
 * another agent, then observe, steer and cancel it — the same durable machinery
 * the A2A v2 protocol drives, so a client speaking either surface sees the same
 * runs in the same states. Each turn is an A2A task; the model addresses the
 * run only by its stable `run_id` (the first turn's task id, which is also its
 * workspace id), and every tool resolves that to the current turn.
 */

const RunFailureSchema = z
  .object({ code: z.string(), retriable: z.boolean() })
  .nullable()
  .describe(
    "Machine-readable failure of a failed run: a stable code and whether a new run of the same Agent is likely to succeed unchanged. Null otherwise.",
  );

const RunSummarySchema = z.object({
  run_id: z
    .string()
    .describe(
      "Stable handle for every follow-up: get_agent_run, steer_agent_run, cancel_agent_run and the workspace file tools.",
    ),
  state: z
    .string()
    .describe(
      "submitted | working | input-required | completed | canceled | failed",
    ),
  agent_id: z.string().nullable().describe("The agent doing the work."),
  status_reason: z
    .string()
    .nullable()
    .describe("Why the run is in its state, when there is something to say."),
  failure: RunFailureSchema,
  created_at: z.string().describe("ISO 8601."),
  state_changed_at: z.string().describe("ISO 8601 of the last transition."),
});

const StartRunOutputSchema = z.object({
  run: RunSummarySchema,
  run_url: z
    .string()
    .describe("Open the run and its workspace in the browser."),
  next_step: z.string().describe("What to do now."),
});

const GetRunOutputSchema = z.object({
  run: RunSummarySchema,
  run_url: z.string().nullable(),
  requests: z
    .array(z.object({ text: z.string(), truncated: z.boolean() }))
    .describe(
      "The run's original request and, when different, the current turn's request. Use this context to interpret short follow-ups.",
    ),
  output: z
    .string()
    .describe("The run's response artifact so far (tail, capped)."),
  output_truncated: z.boolean(),
  workspace: z
    .object({
      state: AgentWorkspaceStateSchema,
      retained_until: z.string(),
      can_continue: z
        .boolean()
        .describe(
          "Whether steer_agent_run can accept a follow-up in this workspace, including while work is running.",
        ),
      continuation_error: z
        .string()
        .nullable()
        .describe(
          "Why this workspace cannot accept steering, or null when available.",
        ),
      connection: z
        .object({ hostname: z.string(), shellCommand: z.string() })
        .nullable(),
    })
    .nullable()
    .describe(
      "The owner's retained workspace, independent of the run's terminal state.",
    ),
  session: z
    .object({
      attachable: z
        .boolean()
        .describe("Whether a live container is carrying the run right now."),
      started_at: z.string().nullable(),
    })
    .nullable()
    .describe("The live container session, when the run uses Agent Runtime."),
});

const ListAgentRunsOutputSchema = z.object({
  runs: z.array(
    z.union([
      RunSummarySchema,
      z.object({
        run_id: z.string().uuid(),
        llm_session_id: z
          .string()
          .nullable()
          .describe(
            "Verified LLM telemetry session key for /llm/logs/:id; URL-encode it as one path segment. Null when no readable logged session is available. This is not a task ID or runtime handle.",
          ),
        title: z.string(),
        prompt: z.string(),
        state: z.string(),
        status_reason: z.string().nullable(),
        failure: RunFailureSchema,
        started_at: z.string(),
        ended_at: z.string().nullable(),
        state_changed_at: z.string().nullable(),
        hard_deadline_at: z
          .string()
          .describe("When the runtime will be forcefully stopped."),
        last_model_activity_at: z
          .string()
          .nullable()
          .describe("Most recent model request attributed to this run."),
        attention_state: AgentRunAttentionStateSchema.nullable().describe(
          "Native runtime signal that the live process needs user attention.",
        ),
        agent: z.object({
          id: z.string().uuid(),
          name: z.string(),
          icon: z.string().nullable(),
        }),
        requester: z.object({
          kind: z.string(),
          id: z.string(),
          name: z.string().nullable(),
        }),
        run_url: z.string().url(),
        thread: z
          .object({
            provider: z.string(),
            channel_id: z.string(),
            channel_name: z.string().nullable(),
            thread_id: z.string(),
            url: z.string().url().nullable(),
          })
          .nullable(),
      }),
    ]),
  ),
  summary: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    by_state: z.record(z.string(), z.number().int().nonnegative()),
  }),
});

/** How much artifact text get_agent_run inlines; the tail is the useful end. */
const MAX_INLINED_OUTPUT_CHARS = 20_000;
// Bounded by the API body limit (a base64 payload plus JSON-RPC envelope must
// fit in one request) and by what a channel thread can reasonably hold. A file
// read from the workspace by path is held to the same cap.
const MAX_RUN_FILE_BYTES = 40 * 1024 * 1024;
/** Where an Agent Runtime's retained workspace is mounted in its container. */
const RUN_WORKSPACE_ROOT = "/home/node/workspace";
const RunFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._ -]*$/,
    "filename must be a plain file name (letters, digits, dot, dash, underscore, space).",
  );

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_DELETE_WORKSPACE_SHORT_NAME,
    title: "Delete Workspace",
    description:
      "Permanently delete a retained runtime workspace and all of its files. Saved run transcripts remain available. Only the owner can delete it. Cancel any active run first and wait for it to finish. Use only when the requester explicitly asks to discard the workspace, not when they only ask to stop a run.",
    schema: z.object({
      run_id: z.string().uuid(),
      confirm_delete: z.literal(true),
    }),
    handler: async ({ args, context }) => {
      try {
        const result = await deleteAgentWorkspace({
          actor: requireActor(context),
          taskId: args.run_id,
        });
        return structuredSuccessResult(
          { run_id: args.run_id, state: result.state },
          "Workspace deleted. Its files cannot be recovered; saved transcripts are still available.",
        );
      } catch (error) {
        return catchError(error, "deleting the workspace");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_READ_WORKSPACE_FILE_SHORT_NAME,
    title: "Read Workspace File",
    description:
      "Read a file from your Agent Runtime's retained workspace using its run_id. Use this when you need the contents yourself — to quote, review or edit them. To hand a file to the user or save it locally, prefer transfer_workspace_file: its bytes move directly and never enter the conversation, so a large file costs no tokens and is not truncated. Paths are relative to /home/node/workspace, not the conversation's skill sandbox. Returns UTF-8 text by default or base64 for binary downloads; maximum 4 MiB. A suspended workspace wakes automatically. Shared transcript access does not grant file access. A read made while the runtime is in the middle of a tool call can return status \"pending\" with no content: call again with the same arguments after that tool call finishes.",
    schema: z.object({
      run_id: z.string().uuid(),
      path: z.string().min(1).max(4096),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    }),
    handler: async ({ args, context }) => {
      let direct = false;
      try {
        const actor = requireActor(context);
        const access = await protectedFileAccess({
          context,
          actor,
          taskId: args.run_id,
        });
        if (access.kind === "error") return access.result;
        direct = access.kind !== "parent";
        const read = async () => {
          const result = await accessAgentWorkspaceFile({
            actor,
            taskId: args.run_id,
            request: { operation: "read", path: args.path },
          });
          const { content_base64, ...metadata } = result;
          const content =
            args.encoding === "base64"
              ? (content_base64 ?? "")
              : decodeWorkspaceText(content_base64 ?? "");
          return { metadata, content };
        };
        if (access.kind !== "parent") {
          const { metadata, content } = await read();
          return structuredSuccessResult({
            ...metadata,
            encoding: args.encoding,
            content,
          });
        }
        const crossed = await pendingExports.crossRead({
          child: access.child,
          actor,
          taskId: args.run_id,
          path: args.path,
          encoding: args.encoding,
          operationId: access.crossing.callId,
          read,
        });
        if (crossed.kind === "pending") {
          // Nothing about the file has crossed yet, not even its size.
          return structuredSuccessResult({
            path: args.path,
            status: "pending",
            message: pendingFileNotice(TOOL_READ_WORKSPACE_FILE_SHORT_NAME),
          });
        }
        return structuredSuccessResult({
          ...crossed.metadata,
          encoding: args.encoding,
          content: crossed.content,
        });
      } catch (error) {
        const refused = crossingRefusal(error);
        if (refused) return errorResult(refused);
        return workspaceFileError({
          direct,
          error,
          failure: `Could not read ${args.path} from the run's workspace`,
          action: "reading workspace file",
        });
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
    title: "Transfer Workspace File",
    description:
      "Copy a file between this machine and a Remote Agent's workspace without reading it. " +
      "Use this to move deliverables, archives, and binaries of any size, including small ones: " +
      "the bytes travel directly and never enter the conversation. " +
      "Authorize the transfer here, then run the returned command in a shell. " +
      "For a download, pass direction 'download' and run the command; it resumes automatically if interrupted. " +
      "For an upload, first compute the local file's size and sha256, pass them here, then run the command. " +
      "The runtime copy is pinned when you authorize a download, so a still-running agent cannot corrupt it. " +
      "An upload refuses rather than overwrite a destination that changed since you authorized it. " +
      "Use read_workspace_file instead only when you need to read a file's contents. " +
      'A download made while the runtime is in the middle of a tool call can return status "pending" and no command: call again with the same arguments after that tool call finishes. ' +
      "Without a shell, fall back to read_workspace_file and write_workspace_file, which are capped at 4 MiB.",
    schema: z.object({
      run_id: z
        .string()
        .uuid()
        .describe("From start_agent_run or list_agent_runs."),
      direction: z
        .enum(["download", "upload"])
        .describe("download reads from the workspace; upload writes to it."),
      path: z
        .string()
        .min(1)
        .max(4096)
        .describe("Workspace-relative path, for example reports/summary.md."),
      local_path: z
        .string()
        .min(1)
        .max(4096)
        .describe("Absolute path on this machine, used to build the command."),
      size: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Upload only: the local file's size in bytes."),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe("Upload only: the local file's sha256, as hex."),
    }),
    handler: async ({ args, context }) => {
      let direct = false;
      try {
        const actor = requireActor(context);
        const access = await protectedFileAccess({
          context,
          actor,
          taskId: args.run_id,
        });
        if (access.kind === "error") return access.result;
        direct = access.kind !== "parent";
        if (
          args.direction === "upload" &&
          (args.size === undefined || !args.sha256)
        ) {
          return errorResult(
            "An upload needs the local file's size and sha256. Compute them first, for example with shasum -a 256.",
          );
        }
        if (args.direction === "download" && access.kind === "parent") {
          const crossed = await pendingExports.crossDownload({
            child: access.child,
            actor,
            taskId: args.run_id,
            path: args.path,
            operationId: access.crossing.callId,
          });
          if (crossed.kind === "pending") {
            // Nothing about the file has crossed yet, not even its size.
            return structuredSuccessResult({
              direction: args.direction,
              path: args.path,
              status: "pending",
              message: pendingFileNotice(
                TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
              ),
            });
          }
          return transferResult({ args, minted: crossed.minted });
        }
        const minted =
          args.direction === "download"
            ? await workspaceTransferTickets.mintDownload({
                actor,
                taskId: args.run_id,
                path: args.path,
              })
            : await workspaceTransferTickets.mintUpload({
                actor,
                taskId: args.run_id,
                path: args.path,
                size: args.size as number,
                sha256: args.sha256 as string,
                ...(access.kind === "parent"
                  ? {
                      crossing: {
                        parent: access.crossing.source,
                        childSessionId: access.child.session_id,
                        operationId: access.crossing.callId,
                      },
                    }
                  : {}),
              });
        return transferResult({ args, minted });
      } catch (error) {
        const refused = crossingRefusal(error);
        if (refused) return errorResult(refused);
        return workspaceFileError({
          direct,
          error,
          failure: `Could not authorize the ${args.direction} of ${args.path}`,
          action: "authorizing a workspace file transfer",
        });
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME,
    title: "Write Workspace File",
    description:
      "Create a file in your Agent Runtime's retained workspace using its run_id. Use this for content you are composing here, such as a note or a short config. To put a file that already exists on this machine into the workspace, prefer transfer_workspace_file: its bytes move directly and never enter the conversation, so a large file costs no tokens and needs no base64 encoding. Paths are relative to /home/node/workspace. Accepts UTF-8 text or base64 binary uploads, maximum 4 MiB decoded. Existing files are preserved unless overwrite=true. Parent directories must exist. This changes the runtime filesystem; it does not post a file to Slack or the conversation's skill sandbox.",
    schema: z.object({
      run_id: z.string().uuid(),
      path: z.string().min(1).max(4096),
      content: z.string().max(5_592_408),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      overwrite: z.boolean().default(false),
    }),
    handler: async ({ args, context }) => {
      let direct = false;
      try {
        const actor = requireActor(context);
        const access = await protectedFileAccess({
          context,
          actor,
          taskId: args.run_id,
        });
        if (access.kind === "error") return access.result;
        direct = access.kind !== "parent";
        if (access.kind === "parent") {
          await admitRuntimeSteer({
            crossing: access.crossing,
            organizationId: actor.organizationId,
            workspaceId: access.workspaceId,
          });
        }
        const result = await accessAgentWorkspaceFile({
          actor,
          taskId: args.run_id,
          request: {
            operation: "write",
            path: args.path,
            content_base64:
              args.encoding === "base64"
                ? args.content
                : Buffer.from(args.content, "utf8").toString("base64"),
            overwrite: args.overwrite,
          },
        });
        return structuredSuccessResult(result);
      } catch (error) {
        const refused = crossingRefusal(error);
        if (refused) return errorResult(refused);
        return workspaceFileError({
          direct,
          error,
          failure: `Could not write ${args.path} to the run's workspace`,
          action: "writing workspace file",
        });
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_START_AGENT_RUN_SHORT_NAME,
    title: "Start Agent Run",
    description:
      "Start a background run on an Agent that has Agent Runtime. It returns at once with run_id and run_url: a handle, not the answer. " +
      `Use it for work that has no run yet, including unfinished local work handed over to ${DEFAULT_APP_NAME}. For a follow-up on an existing run, use steer_agent_run with its run_id; never start a replacement run. ` +
      "Agents without Agent Runtime are refused; delegate to them with their agent tool instead. " +
      "For repository handoffs, first load the Remote Agents Handoff skill using load_skill. Include the repository URL, exact base commit, local changes, and return-patch baseline; local paths are not accessible remotely. " +
      "Include context, goals, decisions and remaining work in message. Optional attachments are staged before execution (repository patches or documents). " +
      "For files sent after startup through transfer_workspace_file, instruct the Agent to prepare and stop before task work. Transfer the files, then continue with steer_agent_run. " +
      "Don't call get_agent_run in the turn that started the run.",
    schema: z.object({
      agent_id: z.string().describe("The agent to do the work."),
      message: z
        .string()
        .trim()
        .min(1, "message is required.")
        .describe(
          "What the agent should do, including handoff context and acceptance criteria.",
        ),
      attachments: agentRunAttachmentsSchema().describe(
        "Input files staged before the first turn. For repository work, include a patch for uncommitted changes and identify the base commit in message. Never include credentials.",
      ),
    }),
    outputSchema: StartRunOutputSchema,
    handler: ({ args, context }) =>
      startDelegatedTask({
        agentId: args.agent_id,
        message: args.message,
        attachments: args.attachments,
        context,
      }),
  }),

  defineArchestraTool({
    shortName: TOOL_GET_AGENT_RUN_SHORT_NAME,
    title: "Get Agent Run",
    description:
      "Read a run's state, the result it has handed back so far, and whether it accepts a follow-up. " +
      "Read requests for the run's context before interpreting a follow-up. " +
      "A run in state 'working' can be steered immediately; do not wait for completion to send instructions. " +
      "Don't poll in the turn that started the run. " +
      "Use transfer_workspace_file to copy deliverables through a local shell, or read_workspace_file to read contents up to 4 MiB.",
    schema: z.object({
      run_id: z
        .string()
        .uuid()
        .describe("From start_agent_run or list_agent_runs."),
    }),
    outputSchema: GetRunOutputSchema,
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const run = await requireAccessibleRun({ runId: args.run_id, actor });
        if ("error" in run) return errorResult(run.error);
        const task = run.row;

        const governed = await governedRunOutput({
          context,
          actor,
          task,
          runId: args.run_id,
        });
        if (governed) return governed;

        const artifacts = await A2AArtifactModel.findByTaskId(task.id);
        const text = artifacts
          .flatMap((artifact) =>
            Array.isArray(artifact.parts) ? artifact.parts : [],
          )
          .map((part) =>
            typeof (part as { text?: unknown }).text === "string"
              ? (part as { text: string }).text
              : "",
          )
          .join("");
        const truncated = text.length > MAX_INLINED_OUTPUT_CHARS;

        const session = await AgentRunModel.findByTaskId(task.id);
        const workspace =
          session &&
          session.actorKind === actor.kind &&
          session.actorId === actor.id
            ? await AgentWorkspaceModel.findByWorkloadName(session.workloadName)
            : null;
        const canContinue = Boolean(
          workspace &&
            ((workspace.state === "active" &&
              !session?.endedAt &&
              workspace.activeTaskId === task.id) ||
              (["idle", "suspended"].includes(workspace.state) &&
                !workspace.activeTaskId)) &&
            workspace.expiresAt.getTime() > Date.now(),
        );
        const continuationError =
          !workspace || canContinue
            ? null
            : workspace.expiresAt.getTime() <= Date.now()
              ? "This run expired and cannot resume. Do not call start_agent_run to replace it. Recover available run history and explain the blocker."
              : workspace.state === "deleted"
                ? "This run's workspace was removed and cannot resume. Do not call start_agent_run to replace it. Recover available run history and explain the blocker."
                : "This workspace is not ready for continuation. Check get_agent_run again and use steer_agent_run with the same run_id when available; do not start a replacement run.";
        const requestTaskIds = [...new Set([args.run_id, task.id])];
        const requestParts =
          await A2AMessageModel.findFirstUserPartsByTaskIds(requestTaskIds);
        const requests = requestTaskIds.flatMap((taskId) => {
          const parts = requestParts.get(taskId);
          if (!parts) return [];
          const request = parts
            .flatMap((part) =>
              part &&
              typeof part === "object" &&
              "text" in part &&
              typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("\n");
          return [
            {
              text: request.slice(0, MAX_INLINED_OUTPUT_CHARS),
              truncated: request.length > MAX_INLINED_OUTPUT_CHARS,
            },
          ];
        });

        return structuredSuccessResult({
          run: runSummary({
            row: task,
            runId: args.run_id,
            narrow: await isGuardrailsV2Active(),
          }),
          run_url: session ? agentRunUrl(args.run_id) : null,
          requests,
          // The tail: the newest output is what a poller wants to see.
          output: truncated ? text.slice(-MAX_INLINED_OUTPUT_CHARS) : text,
          output_truncated: truncated,
          workspace: workspace
            ? {
                state: workspace.state,
                retained_until: workspace.expiresAt.toISOString(),
                can_continue: canContinue,
                continuation_error: continuationError,
                connection:
                  session && ["active", "idle"].includes(workspace.state)
                    ? await resolveAgentRuntimeBackendDriver(
                        session.backend,
                      ).getWorkspaceConnection(session)
                    : null,
              }
            : null,
          session: session
            ? {
                attachable: session.endedAt === null,
                started_at: session.startedAt?.toISOString() ?? null,
              }
            : null,
        });
      } catch (error) {
        const refused = crossingRefusal(error);
        if (refused) return errorResult(refused);
        return catchError(error, "reading the run");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_LIST_AGENT_RUNS_SHORT_NAME,
    title: "List Agent Runs",
    description:
      "List recent runs on one or more accessible Agents, newest first. " +
      "By default lists everyone's runs on those Agents with status, requester, run links, and originating messaging threads when present. " +
      "Set mine_only to list only your own runs. " +
      "Use current_thread_only to recover runs from the current messaging thread even when no run link was posted.",
    schema: z.object({
      agent_ids: z.array(z.string().uuid()).min(1).max(20),
      mine_only: z.boolean().default(false).describe("Only runs you started."),
      state: z
        .enum([
          "submitted",
          "working",
          "input-required",
          "completed",
          "canceled",
          "failed",
        ])
        .optional()
        .describe("Only runs in this state."),
      current_thread_only: z
        .boolean()
        .default(false)
        .describe(
          "Only runs originating in the current messaging thread. Requires messaging context; never falls back to an unfiltered list.",
        ),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    outputSchema: ListAgentRunsOutputSchema,
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const thread = args.current_thread_only
          ? context.chatOpsBindingId && context.chatOpsThreadId
            ? {
                bindingId: context.chatOpsBindingId,
                threadId: context.chatOpsThreadId,
              }
            : null
          : undefined;
        if (thread === null) {
          return errorResult("Current messaging thread context is unavailable");
        }
        if (thread && args.mine_only) {
          return errorResult(
            "current_thread_only lists every run from the thread; it cannot be combined with mine_only.",
          );
        }
        const requestedAgentIds = [...new Set(args.agent_ids)];
        const state = args.state
          ? FRIENDLY_TO_PROTOCOL_STATE[args.state]
          : undefined;
        const narrow = await isGuardrailsV2Active();

        const agents = await AgentModel.findBasicByOrganizationIdAndIds({
          organizationId: actor.organizationId,
          agentIds: requestedAgentIds,
        });
        if (agents.length !== requestedAgentIds.length) {
          return errorResult("Agent not found");
        }

        if (args.mine_only) {
          const { tasks, totalSize } = await A2ATaskModel.listForActor({
            actorKind: actor.kind,
            actorId: actor.id,
            agentIds: requestedAgentIds,
            state,
            pageSize: args.limit,
            currentTurnsOnly: true,
            organizationId: actor.organizationId,
          });
          const runIds = await AgentRunModel.findRunIdsByTaskIds(
            tasks.map((task) => task.id),
          );
          const runs = tasks.map((task) =>
            runSummary({
              row: task,
              runId: runIds.get(task.id) ?? task.id,
              narrow,
            }),
          );
          return structuredSuccessResult({
            runs,
            summary: { ...countRuns(runs), total: totalSize },
          });
        }

        const isAgentAdmin = await ResourcePermissions.allows({
          userId: actor.id,
          organizationId: actor.organizationId,
          resource: "agent",
          scope: "*",
          action: "update",
        });
        const accessible = new Set(
          await AgentTeamModel.getUserAccessibleAgentIds(
            actor.id,
            isAgentAdmin,
          ),
        );
        if (agents.some((agent) => !accessible.has(agent.id))) {
          return errorResult("Agent not found");
        }

        const rows = await AgentRunModel.listDashboard({
          agentIds: requestedAgentIds,
          organizationId: actor.organizationId,
          limit: args.limit,
          state,
          thread,
        });
        const [canReadLogs, canReadAllLogs] = await Promise.all([
          userHasPermission(actor.id, actor.organizationId, "log", "read"),
          userHasPermission(actor.id, actor.organizationId, "log", "admin"),
        ]);
        // Maintained runtime clients send the persisted workload name as
        // X-Archestra-Session-Id. The OpenAPPA key adds a caller scope and is
        // not the key stored on LLM interactions. Never substitute a task ID
        // or a workspace row's UUID; continued turns keep this header value.
        const sessionKeys = rows.map((row) => row.workloadName);
        const logged = canReadLogs
          ? await InteractionModel.findLoggedSessionIds({
              organizationId: actor.organizationId,
              sessionIds: sessionKeys,
              ...(canReadAllLogs ? {} : { ownUserId: actor.id }),
            })
          : new Set<string>();
        // Prompts and their generated titles may hold other people's data;
        // an app's own code still gets the title it renders.
        const hideTitle = narrow && !context.appId;
        const runs = rows.map((row, index) => ({
          llm_session_id: logged.has(sessionKeys[index])
            ? sessionKeys[index]
            : null,
          run_id: row.runId,
          title: hideTitle ? "" : row.title,
          prompt: narrow ? "" : row.prompt,
          state: displayState(row.state),
          status_reason: modelFacingStatusReason(row.statusReason, narrow),
          failure: row.failure
            ? { code: row.failure.code, retriable: row.failure.retriable }
            : null,
          started_at: row.startedAt.toISOString(),
          ended_at: row.endedAt?.toISOString() ?? null,
          state_changed_at: row.stateChangedAt?.toISOString() ?? null,
          hard_deadline_at: row.hardDeadlineAt.toISOString(),
          last_model_activity_at:
            row.lastModelActivityAt?.toISOString() ?? null,
          attention_state: row.attentionState,
          agent: {
            id: row.agentId,
            name: row.agentName,
            icon: row.agentIcon,
          },
          requester: {
            kind: row.actorKind,
            id: row.actorId,
            name: row.actorName,
          },
          run_url: agentRunUrl(row.runId),
          thread: buildRunThread(row),
        }));

        return structuredSuccessResult({
          runs,
          summary: countRuns(runs),
        });
      } catch (error) {
        return catchError(error, "listing Agent runs");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_STEER_AGENT_RUN_SHORT_NAME,
    title: "Steer Agent Run",
    description:
      "Send one message to a run: a course correction to a live run without stopping the work, " +
      "or, when the run has finished and its workspace is retained, a follow-up that continues the SAME run " +
      "and saved conversation there with the same Agent. " +
      "Pass the run's run_id, even after switching clients or completing earlier turns. " +
      "Never use start_agent_run as a fallback: unavailable or expired runs return an error, not a new workspace. Only Agent Runtime runs can be steered.",
    schema: z.object({
      run_id: z.string().uuid(),
      message: z
        .string()
        .trim()
        .min(1, "message is required.")
        .refine(
          (message) => !message.includes("\0"),
          "message cannot contain a NUL character. Describe it as U+0000 or an escaped \\u0000 sequence instead.",
        ),
    }),
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const run = await requireAccessibleRun({ runId: args.run_id, actor });
        if ("error" in run) return errorResult(run.error);

        const session = await AgentRunModel.findByTaskId(run.row.id);
        if (!session) {
          return errorResult(
            "This run has no container workspace. In-process runs cannot be steered.",
          );
        }
        // Narrower than run access on purpose: steering types into a shell
        // holding that person's own credentials.
        if (session.actorUserId !== actor.id) {
          return errorResult("Only the person the run acts as can steer it.");
        }
        const agent = await AgentModel.findById(session.agentId);
        const runtime = agent ? resolveAgentRuntime(agent) : null;
        if (!agent || !runtime) {
          return errorResult(
            "The Agent no longer has Agent Runtime configured.",
          );
        }

        const workspace = await AgentWorkspaceModel.findByWorkloadName(
          session.workloadName,
        );
        const crossing = await parentCrossing({
          context,
          organizationId: actor.organizationId,
          workspaceId: workspace?.id,
        });
        if (typeof crossing === "string") return errorResult(crossing);
        if (crossing && workspace) {
          await admitRuntimeSteer({
            crossing,
            organizationId: actor.organizationId,
            workspaceId: workspace.id,
          });
        }
        // The result is a host-written acknowledgement: it carries the run's
        // handle and nothing the run produced.
        const accepted = (status: "continued" | "steered") =>
          structuredSuccessResult({
            status,
            run_id: args.run_id,
            run_url: agentRunUrl(args.run_id),
            next_step: submittedRunNextStep({
              reportsToThread: Boolean(session.completionTarget),
            }),
          });
        if (session.endedAt) {
          if (
            !workspace ||
            workspace.expiresAt.getTime() <= Date.now() ||
            !["idle", "suspended"].includes(workspace.state) ||
            workspace.activeTaskId
          ) {
            return errorResult(
              "The run is unavailable, busy, or expired. No new run was started. Read get_agent_run for its current state; do not use start_agent_run as a retry.",
            );
          }
          const continuation = await startDetachedAgentTask({
            actor,
            agentId: session.agentId,
            message: args.message,
            systemParams: {
              resumeFromTaskId: session.taskId,
              completionTarget: session.completionTarget ?? undefined,
              projectId: session.projectId ?? undefined,
              ...(crossing ? { runtimeCrossing: crossing } : {}),
            },
          });
          if (session.completionTarget) {
            void watchTaskCompletion({
              taskId: continuation.id,
              target: session.completionTarget,
              agentName: agent.name,
            }).catch((error) => {
              logger.warn(
                { error, taskId: continuation.id },
                "Failed to watch Agent continuation for completion",
              );
            });
          }
          return accepted("continued");
        }

        await resolveAgentRuntimeBackendDriver(session.backend).steer({
          session,
          steerMode: runtime.steerMode,
          message: args.message,
        });
        return accepted("steered");
      } catch (error) {
        const needed = missingCredentialsFrom(error);
        if (needed) {
          return credentialsNeededResult(needed.agentId, needed.missing);
        }
        const refused = crossingRefusal(error);
        if (refused) return errorResult(refused);
        return catchError(error, "steering the run");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_CANCEL_AGENT_RUN_SHORT_NAME,
    title: "Cancel Agent Run",
    description:
      "Stop an active run. Its workspace, saved files, and history are retained for a later continuation; this does not delete the workspace.",
    schema: z.object({
      run_id: z.string().uuid(),
    }),
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const run = await requireAccessibleRun({ runId: args.run_id, actor });
        if ("error" in run) return errorResult(run.error);
        const task = run.row;
        if (!task.agentId) {
          return errorResult("This run has no agent to cancel against.");
        }

        let canceled: Awaited<ReturnType<typeof cancelDetachedAgentTask>>;
        try {
          canceled = await cancelDetachedAgentTask({
            actor,
            agentId: task.agentId,
            taskId: task.id,
          });
        } catch (error) {
          if (
            error instanceof A2AError &&
            error.kind === A2AErrorKind.TaskNotCancelable
          ) {
            // Completion can win after the access check or during cancellation.
            // Report the same turn's persisted outcome; never cancel a newer turn.
            const current = await A2ATaskModel.findById(task.id);
            if (!current) throw error;
            return errorResult(
              `Run ${args.run_id} cannot be canceled because it is already terminal (${current.state}). No cancellation was performed. Its workspace and history are retained.`,
            );
          }
          throw error;
        }
        const canceledRow = await A2ATaskModel.findById(task.id);
        if (!canceledRow) {
          throw new Error("Canceled run was not persisted");
        }
        return structuredSuccessResult(
          {
            run: runSummary({
              row: canceledRow,
              runId: args.run_id,
              narrow: await isGuardrailsV2Active(),
            }),
          },
          `Run ${args.run_id}: ${describeProtocolState(canceled)}`,
        );
      } catch (error) {
        return catchError(error, "canceling the run");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_POST_AGENT_RUN_MESSAGE_SHORT_NAME,
    title: "Post Agent Run Message",
    description:
      "Post a brief update to the Slack thread an active Agent Runtime run reports to. " +
      "Use before the turn ends for meaningful progress, a change of plan, a long wait, or to notify the user that input or approval is needed. " +
      "Posting does not end the turn or wait for a reply; collect input and approvals through the available question or approval interface. " +
      "Read the current task_id from ARCHESTRA_AGENT_RUNTIME_TASK_ID. " +
      "The final answer is posted automatically; do not repeat it here.",
    schema: z.object({
      task_id: z.string().uuid(),
      message: z.string().trim().min(1).max(2_000),
    }),
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const task = await requireAccessibleTask({
          taskId: args.task_id,
          actor,
        });
        if ("error" in task) return errorResult(task.error);

        const session = await AgentRunModel.findByTaskId(task.row.id);
        if (!session || session.actorUserId !== actor.id) {
          return errorResult(
            "Only the person the runtime run acts as can post updates for it.",
          );
        }
        if (session.endedAt || task.row.state !== "TASK_STATE_WORKING") {
          return errorResult(
            "This runtime run is not active. No message was posted.",
          );
        }
        const access = await protectedFileAccess({
          context,
          actor,
          taskId: task.row.id,
        });
        if (access.kind === "error") return access.result;
        if (access.kind === "parent") {
          return errorResult(
            "A protected runtime cannot post updates from another session.",
          );
        }
        const target = session.completionTarget;
        if (!target || target.type !== "chatops") {
          return errorResult(
            "This runtime run does not report to a Slack thread.",
          );
        }
        const agent = await AgentModel.findById(session.agentId);
        const { chatOpsManager } = await import(
          "@/agents/chatops/chatops-manager"
        );
        const sent = await chatOpsManager.notifyBindingThread({
          taskId: task.row.id,
          bindingId: target.bindingId,
          threadId: target.threadId,
          pinnedAgentId: target.pinnedAgentId,
          agentName: agent?.name,
          text: args.message,
          progress: true,
          ...(target.originatingTaskId === task.row.id && {
            muteMarkerAtStart: target.muteMarkerAtStart,
          }),
        });
        return structuredSuccessResult(
          { sent, task_id: task.row.id },
          sent
            ? "Progress update posted to the run's Slack thread."
            : "No update was posted because the thread is muted or the message requests silence.",
        );
      } catch (error) {
        return catchError(error, "posting the run update");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_POST_AGENT_RUN_FILE_SHORT_NAME,
    title: "Post Agent Run File",
    description:
      "Upload a file into the messaging-channel thread a run reports to — a demo recording, " +
      "for example — so it renders natively there (Slack plays video uploads inline). Only " +
      "runs delegated from a bound messaging channel have such a thread. " +
      "From inside the run, pass path: the file is read from the run's own workspace, so its bytes never enter the conversation. " +
      `Copy a file that is outside ${RUN_WORKSPACE_ROOT} into it first. ` +
      "Pass content_base64 only for a small file that is not in the workspace. Exactly one of the two is required. " +
      `Files up to ${MAX_RUN_FILE_BYTES / 1024 / 1024} MB.`,
    schema: z.object({
      task_id: z.string().uuid(),
      path: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          `The file in the run's own workspace, relative to ${RUN_WORKSPACE_ROOT} (for example demo/demo.mp4) or absolute under it.`,
        ),
      filename: RunFileNameSchema.optional().describe(
        "Name shown in the thread. Defaults to the last part of path; required with content_base64.",
      ),
      content_base64: z
        .string()
        .min(1)
        .optional()
        .describe("The file's bytes, base64-encoded, when there is no path."),
      comment: z.string().trim().max(2_000).optional(),
    }),
    handler: async ({ args, context }) => {
      try {
        // Malformed arguments are refused before any run or Guardrails lookup.
        const input = runFileInput(args);
        if ("error" in input) return errorResult(input.error);
        const actor = requireActor(context);
        const task = await requireAccessibleTask({
          taskId: args.task_id,
          actor,
        });
        if ("error" in task) return errorResult(task.error);

        const session = await AgentRunModel.findByTaskId(task.row.id);
        if (!session) {
          return errorResult(
            "This run has no container session, so there is no thread to post to.",
          );
        }
        // Same narrowing as steering: the upload appears in the thread as the
        // run's own delivery, acting for the person the run runs as.
        if (session.actorUserId !== actor.id) {
          return errorResult(
            "Only the person the run acts as can post files for it.",
          );
        }
        const posted = await protectedFileAccess({
          context,
          actor,
          taskId: task.row.id,
        });
        if (posted.kind === "error") return posted.result;
        if (posted.kind === "parent") {
          return errorResult(
            "A protected runtime file cannot be posted from another session. The bytes were not sent.",
          );
        }
        const target = session.completionTarget;
        if (!target || target.type !== "chatops") {
          return errorResult(
            "This run does not report to a messaging-channel thread.",
          );
        }

        const file =
          input.kind === "bytes"
            ? input
            : await readRunFile({ actor, taskId: task.row.id, input });
        if ("error" in file) return errorResult(file.error);
        const { filename, data } = file;

        const { chatOpsManager } = await import(
          "@/agents/chatops/chatops-manager"
        );
        await chatOpsManager.uploadFileToBindingThread({
          bindingId: target.bindingId,
          threadId: target.threadId,
          pinnedAgentId: target.pinnedAgentId,
          filename,
          data,
          comment: args.comment,
        });
        return structuredSuccessResult(
          { success: true, task_id: task.row.id },
          "File posted to the run's thread.",
        );
      } catch (error) {
        return catchError(error, "posting the run file");
      }
    },
  }),
]);

/** Quote a value for a POSIX shell so a path or token cannot break the command
 * the model is told to run. */
function shellQuoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === Internal helpers ===

type RunFileInput =
  | { kind: "bytes"; filename: string; data: Buffer }
  | { kind: "path"; path: string; filename: string };

/**
 * Checks `post_agent_run_file`'s arguments without touching the run: exactly one of
 * path and content_base64, a plain file name, and bytes within the cap.
 */
function runFileInput(args: {
  path?: string;
  filename?: string;
  content_base64?: string;
}): RunFileInput | { error: string } {
  const hasPath = args.path !== undefined;
  const hasBytes = args.content_base64 !== undefined;
  if (hasPath === hasBytes) {
    return {
      error:
        "Pass exactly one of path or content_base64. Prefer path for a file in the run's workspace.",
    };
  }
  if (args.content_base64 !== undefined) {
    if (!args.filename) {
      return { error: "Pass filename with content_base64." };
    }
    const data = Buffer.from(args.content_base64, "base64");
    if (data.length === 0) {
      return { error: "content_base64 decoded to an empty file." };
    }
    if (data.length > MAX_RUN_FILE_BYTES) {
      return { error: tooLarge(data.length) };
    }
    return { kind: "bytes", filename: args.filename, data };
  }
  const relative = stripWorkspaceRoot(args.path ?? "");
  if (relative === "") {
    return {
      error: `Pass the path of a file in the run's workspace, for example demo/demo.mp4 or ${RUN_WORKSPACE_ROOT}/demo/demo.mp4.`,
    };
  }
  const filename = RunFileNameSchema.safeParse(
    args.filename ?? path.posix.basename(relative),
  );
  if (!filename.success) {
    return {
      error: `The file name ${JSON.stringify(path.posix.basename(relative))} is not a plain file name. Pass filename (letters, digits, dot, dash, underscore, space).`,
    };
  }
  return { kind: "path", path: relative, filename: filename.data };
}

/**
 * The model in the run sees its files at absolute paths, so an absolute path
 * under the workspace root, or one starting with ./, names the same file. The
 * root itself names no file and comes back empty. Any other value comes back
 * unchanged, so the result is not always relative: the transfer helper refuses
 * an absolute path outside the workspace.
 */
function stripWorkspaceRoot(value: string): string {
  if (value === RUN_WORKSPACE_ROOT) return "";
  const relative = value.startsWith(`${RUN_WORKSPACE_ROOT}/`)
    ? value.slice(RUN_WORKSPACE_ROOT.length + 1)
    : value;
  return relative.replace(/^(\.\/)+/, "");
}

/**
 * Reads a file from the run's own workspace through the transfer helper,
 * which refuses traversal, symlinks and anything that is not a regular file.
 * The file is pinned first, so its size is checked before any byte is read
 * and the bytes read are the pinned version's.
 */
async function readRunFile(params: {
  actor: A2AActor;
  taskId: string;
  input: Extract<RunFileInput, { kind: "path" }>;
}): Promise<{ filename: string; data: Buffer } | { error: string }> {
  const { input } = params;
  const where = { actor: params.actor, taskId: params.taskId };
  try {
    const snapshot = await workspaceTransferTickets.pinFile({
      ...where,
      path: input.path,
    });
    try {
      if (snapshot.size === 0) {
        return { error: `${input.path} is empty in the run's workspace.` };
      }
      if (snapshot.size > MAX_RUN_FILE_BYTES) {
        return { error: tooLarge(snapshot.size) };
      }
      const data = await workspaceTransferTickets.readPinned({
        ...where,
        snapshot,
      });
      return { filename: input.filename, data };
    } finally {
      await workspaceTransferTickets
        .discardExport({ ...where, transferId: snapshot.transferId })
        .catch((error) =>
          logger.warn(
            { err: error, taskId: params.taskId },
            "Could not release a run file pinned for posting",
          ),
        );
    }
  } catch (error) {
    const reason = workspaceRefusal(error);
    if (reason !== undefined) {
      return {
        error: `Could not read ${input.path} from the run's workspace: ${reason}`,
      };
    }
    throw error;
  }
}

/**
 * Says why a file tool failed when the caller reads its own runtime. A
 * Guardrails parent (`direct: false`) gets only the generic message: nothing
 * about the file, not even whether it exists, may reach the parent before the
 * file crosses.
 */
function workspaceFileError(params: {
  direct: boolean;
  error: unknown;
  failure: string;
  action: string;
}): CallToolResult {
  const reason = params.direct ? workspaceRefusal(params.error) : undefined;
  if (reason === undefined) return catchError(params.error, params.action);
  logger.info({ err: params.error }, `Refused ${params.action}`);
  return errorResult(`${params.failure}: ${reason}`);
}

/**
 * The file helper's refusals (a missing file, a path rule, a size limit) and
 * the workspace gate's lifecycle answers say what the caller can fix and never
 * carry file bytes. Anything else is not for the caller.
 */
function workspaceRefusal(error: unknown): string | undefined {
  return error instanceof ApiError && error.statusCode < 500
    ? error.message
    : undefined;
}

/** Strict UTF-8, so binary bytes are refused instead of mangled. */
function decodeWorkspaceText(contentBase64: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(contentBase64, "base64"),
    );
  } catch {
    throw new ApiError(
      400,
      "This file is not UTF-8 text. Read it with encoding base64.",
    );
  }
}

function tooLarge(bytes: number): string {
  return `The file is ${Math.round(bytes / 1024 / 1024)}MB; keep run files under ${Math.round(MAX_RUN_FILE_BYTES / 1024 / 1024)}MB.`;
}

/**
 * The refusal as a prompt: the exact keys still needed, and a deep link into
 * the platform where this person deposits them.
 */
function credentialsNeededResult(
  agentId: string,
  missing: Array<{ key: string; label: string; description?: string }>,
) {
  const url = agentCredentialSetupUrl(
    agentId,
    missing.map(({ key }) => key),
  );
  return errorResult(
    `This Agent's Agent Runtime needs credentials you have not set up yet:\n${missing
      .map(
        (entry) =>
          `- ${entry.label} (${entry.key})${entry.description ? `: ${entry.description}` : ""}`,
      )
      .join(
        "\n",
      )}\n\nPut this link in your reply text, never inside a question form, so the user can add them, then start the run again: ${url}`,
  );
}

function buildRunThread(
  row: Awaited<ReturnType<typeof AgentRunModel.listDashboard>>[number],
) {
  if (!row.threadProvider || !row.threadChannelId || !row.threadId) return null;

  const url =
    row.threadProvider === "slack" && row.threadWorkspaceId
      ? `https://app.slack.com/client/${encodeURIComponent(row.threadWorkspaceId)}/${encodeURIComponent(row.threadChannelId)}/thread/${encodeURIComponent(row.threadChannelId)}-${encodeURIComponent(row.threadId)}`
      : null;
  return {
    provider: row.threadProvider,
    channel_id: row.threadChannelId,
    channel_name: row.threadChannelName,
    thread_id: row.threadId,
    url,
  };
}

const ACTIVE_RUN_STATES = new Set(["submitted", "working", "input-required"]);

function countRuns(runs: Array<{ state: string }>) {
  const byState = runs.reduce<Record<string, number>>((counts, run) => {
    counts[run.state] = (counts[run.state] ?? 0) + 1;
    return counts;
  }, {});
  return {
    total: runs.length,
    active: runs.filter((run) => ACTIVE_RUN_STATES.has(run.state)).length,
    by_state: byState,
  };
}

/** The missing-credential list when the error is that refusal; null otherwise. */
function missingCredentialsFrom(error: unknown): {
  agentId: string;
  missing: Array<{ key: string; label: string; description?: string }>;
} | null {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code ===
      AGENT_RUNTIME_CREDENTIALS_REQUIRED_CODE &&
    typeof (error as { agentId?: unknown }).agentId === "string" &&
    Array.isArray((error as { missing?: unknown }).missing)
  ) {
    return error as {
      agentId: string;
      missing: Array<{ key: string; label: string; description?: string }>;
    };
  }
  return null;
}

/** @public — also used by the credential transfer tool in `./credentials`. */
export function requireActor(context: ArchestraContext): A2AActor {
  if (!context.userId || !context.organizationId) {
    throw new Error(
      "Run tools act as the calling user, so they need an authenticated user context.",
    );
  }
  return {
    id: context.userId,
    kind: "user",
    organizationId: context.organizationId,
  };
}

/** The current turn of a run the caller may see, addressed by its run_id. */
async function requireAccessibleRun(params: {
  runId: string;
  actor: A2AActor;
}): ReturnType<typeof requireAccessibleTask> {
  const taskId = await AgentRunModel.findCurrentTurnTaskId({
    runId: params.runId,
    organizationId: params.actor.organizationId,
  });
  if (!taskId) return { error: "Run not found" };
  return requireAccessibleTask({ taskId, actor: params.actor });
}

/**
 * A turn the caller may see: their own, or any in their organization when they
 * hold agent:admin. Missing and inaccessible return the same message so run
 * ids cannot be probed.
 */
async function requireAccessibleTask({
  taskId,
  actor,
}: {
  taskId: string;
  actor: A2AActor;
}): Promise<
  | { row: Awaited<ReturnType<typeof A2ATaskModel.findById>> & object }
  | { error: string }
> {
  const notFound = { error: "Run not found" };
  const row = await A2ATaskModel.findById(taskId);
  if (!row) return notFound;

  // Contexts carry no organization; the task's agent does. A task without an
  // agent is only ever visible to its own actor.
  if (row.agentId) {
    const agent = await AgentModel.findById(row.agentId);
    if (!agent || agent.organizationId !== actor.organizationId) {
      return notFound;
    }
  }

  const context = await A2ATaskModel.findActorForTask(taskId);
  const isOwn =
    context !== null &&
    context.actorKind === actor.kind &&
    context.actorId === actor.id;
  if (!isOwn) {
    const isAdmin =
      row.agentId !== null &&
      (await ResourcePermissions.allows({
        userId: actor.id,
        organizationId: actor.organizationId,
        resource: "agent",
        scope: "*",
        action: "update",
      }));
    if (!isAdmin) return notFound;
  }
  return { row };
}

function failedLaunch(
  reason: RuntimeLaunchFailureReason,
  result: CallToolResult,
  details: { setup_url?: string } = {},
): { result: CallToolResult; outcome: RuntimeLaunchOutcome } {
  return { result, outcome: { kind: "failed", reason, ...details } };
}

function credentialsNeededLaunch(
  agentId: string,
  missing: Array<{ key: string; label: string; description?: string }>,
) {
  return failedLaunch(
    "credentials_needed",
    credentialsNeededResult(agentId, missing),
    {
      setup_url: agentCredentialSetupUrl(
        agentId,
        missing.map(({ key }) => key),
      ),
    },
  );
}

/**
 * Stores the outcome of a launch that OpenAPPA released as a spawn, before the
 * client gets the result. The proxy tells the model what this record says. A
 * record that fails to write leaves the model with no handle; it does not
 * fail a run that already started.
 */
async function recordRuntimeLaunch(
  context: Pick<ArchestraContext, "openappaRuntimeCall">,
  outcome: RuntimeLaunchOutcome,
): Promise<void> {
  const call = context.openappaRuntimeCall;
  if (!call?.spawn) return;
  try {
    await OpenAppaSpawnCorrelationModel.recordRuntimeLaunch({
      organizationId: call.session.organization_id,
      callerId: call.session.caller_id,
      sessionId: call.session.session_id,
      toolCallId: call.toolCallId,
      outcome,
    });
  } catch (error) {
    logger.warn(
      { err: error, toolCallId: call.toolCallId },
      "OpenAPPA could not record the outcome of a runtime launch",
    );
  }
}

async function runtimeCrossingForStart(
  context: Parameters<typeof guardRuntimeCrossing>[0],
): Promise<RuntimeCrossing | undefined | string> {
  const gate = await guardRuntimeCrossing(context);
  if (gate.kind === "refused") return gate.reason;
  // An unrecognized client has no session to bind: its run starts unbound,
  // like one started from the run page.
  if (gate.kind === "inactive" || gate.kind === "unrecognized") {
    return undefined;
  }
  if (!gate.crossing.spawn) {
    return reportCrossingRefusal({
      reason: "not_a_spawn",
      message: NOT_A_SPAWN,
      parentSessionId: gate.crossing.source.session_id,
    });
  }
  return gate.crossing;
}

/**
 * Only metadata and a command cross this boundary. The file itself moves over
 * HTTP, so its bytes never reach a model context.
 */
function transferResult(params: {
  args: { direction: "download" | "upload"; local_path: string };
  minted: Awaited<ReturnType<typeof workspaceTransferTickets.mintUpload>>;
}): ReturnType<typeof structuredSuccessResult> {
  const { args, minted } = params;
  const url = `${getAppAssetBaseOrigin()}${AGENT_WORKSPACE_TRANSFER_PREFIX}/${minted.ticket.id}/content`;
  return structuredSuccessResult({
    direction: args.direction,
    path: minted.ticket.path,
    size: minted.ticket.size,
    sha256: minted.ticket.sha256,
    expires_in_seconds: Math.floor(WORKSPACE_TRANSFER_TICKET_TTL_MS / 1000),
    command:
      args.direction === "download"
        ? `curl --fail --location --continue-at - --output ${shellQuoteArgument(args.local_path)} --header ${shellQuoteArgument(`Authorization: Bearer ${minted.token}`)} ${shellQuoteArgument(url)}`
        : `curl --fail-with-body --upload-file ${shellQuoteArgument(args.local_path)} --header ${shellQuoteArgument("Content-Type: application/octet-stream")} --header ${shellQuoteArgument(`Authorization: Bearer ${minted.token}`)} ${shellQuoteArgument(url)}`,
    next_step:
      args.direction === "download"
        ? "Run the command. Re-run the same command to resume an interrupted download. A refused request (HTTP 404 or 409) writes no file; authorize the transfer again instead."
        : "Run the command. It reports the stored path, size and checksum on success.",
  });
}

async function parentCrossing(params: {
  context: Parameters<typeof guardRuntimeCrossing>[0];
  organizationId: string;
  workspaceId: string | undefined;
}): Promise<RuntimeCrossing | undefined | string> {
  const { workspaceId } = params;
  const gate = await guardRuntimeCrossing(params.context);
  if (gate.kind === "refused") return gate.reason;
  if (gate.kind === "unrecognized") {
    return refuseUnrecognizedCaller({
      organizationId: params.organizationId,
      workspaceId,
    });
  }
  if (gate.kind === "inactive") return undefined;
  if (!workspaceId) {
    return reportCrossingRefusal({
      reason: "unverified_session",
      message: UNVERIFIED_RUNTIME_SESSION,
      parentSessionId: gate.crossing.source.session_id,
    });
  }
  return gate.crossing;
}

async function protectedFileAccess(params: {
  context: Parameters<typeof guardRuntimeCrossing>[0];
  actor: A2AActor;
  taskId: string;
}): Promise<
  | { kind: "open" }
  | { kind: "producer" }
  | {
      kind: "parent";
      child: import("@/openappa/service").OpenAppaSession;
      crossing: RuntimeCrossing;
      workspaceId: string;
    }
  | { kind: "error"; result: ReturnType<typeof errorResult> }
> {
  const session = await AgentRunModel.findByTaskId(params.taskId);
  const workspace = session
    ? await AgentWorkspaceModel.findByWorkloadName(session.workloadName)
    : null;
  if (!session || !workspace) return { kind: "open" };
  const gate = await guardRuntimeCrossing(params.context);
  if (gate.kind === "refused") {
    return { kind: "error", result: errorResult(gate.reason) };
  }
  if (gate.kind === "unrecognized") {
    const refusal = await refuseUnrecognizedCaller({
      organizationId: params.actor.organizationId,
      workspaceId: workspace.id,
    });
    return refusal
      ? { kind: "error", result: errorResult(refusal) }
      : { kind: "open" };
  }
  if (gate.kind === "inactive") return { kind: "open" };
  const relation = await classifyRuntimeCaller({
    crossing: gate.crossing,
    organizationId: params.actor.organizationId,
    workspaceId: workspace.id,
  });
  if (relation.kind === "refused") {
    return { kind: "error", result: errorResult(relation.reason) };
  }
  if (relation.kind === "producer") return { kind: "producer" };
  return {
    kind: "parent",
    child: relation.child,
    crossing: gate.crossing,
    workspaceId: workspace.id,
  };
}

/**
 * get_agent_run's governed result, or undefined when the raw output may be
 * read: Guardrails are off, or an unrecognized client reads a run no session
 * is bound to. Under a proof only a result admitted across the runtime
 * crossing is returned; a run without runtime metadata, a historical turn or
 * the run reading itself gets metadata and the run page, never the raw
 * artifact or request text.
 */
async function governedRunOutput(params: {
  context: Parameters<typeof guardRuntimeCrossing>[0];
  actor: A2AActor;
  task: RunSummaryRow;
  runId: string;
}): Promise<CallToolResult | undefined> {
  const gate = await guardRuntimeCrossing(params.context);
  if (gate.kind === "inactive") return undefined;
  const session = await AgentRunModel.findByTaskId(params.task.id);
  const workspace = session
    ? await AgentWorkspaceModel.findByWorkloadName(session.workloadName)
    : null;
  if (gate.kind === "refused") {
    // A task with no runtime has no output to govern.
    return session && workspace ? errorResult(gate.reason) : undefined;
  }
  const withheld = () =>
    structuredSuccessResult(
      {
        run: runSummary({
          row: params.task,
          runId: params.runId,
          narrow: true,
        }),
        run_url: session ? agentRunUrl(params.runId) : null,
        requests: [],
        output: "",
        output_truncated: false,
        workspace: null,
        session: null,
      },
      "Guardrails cannot verify this run's output for this conversation, so none was returned. A person can read it on the run page.",
    );
  if (gate.kind === "unrecognized") {
    if (!session || !workspace) return undefined;
    const refusal = await refuseUnrecognizedCaller({
      organizationId: params.actor.organizationId,
      workspaceId: workspace.id,
    });
    return refusal ? errorResult(refusal) : undefined;
  }
  if (!session || !workspace) return withheld();
  const crossed = await crossRuntimeOutput({
    crossing: gate.crossing,
    organizationId: params.actor.organizationId,
    workspaceId: workspace.id,
    taskId: params.task.id,
  });
  if (crossed.kind === "producer") return withheld();
  if (crossed.kind === "refused") return errorResult(crossed.reason);
  const canContinue = Boolean(
    (workspace.state === "active" &&
      !session.endedAt &&
      workspace.activeTaskId === params.task.id) ||
      (["idle", "suspended"].includes(workspace.state) &&
        !workspace.activeTaskId),
  );
  return structuredSuccessResult(
    {
      run: runSummary({ row: params.task, runId: params.runId, narrow: true }),
      run_url: agentRunUrl(params.runId),
      requests: [],
      output: crossed.kind === "admitted" ? crossed.value : "",
      output_truncated: false,
      workspace: {
        state: workspace.state,
        retained_until: workspace.expiresAt.toISOString(),
        can_continue: canContinue && workspace.expiresAt.getTime() > Date.now(),
        continuation_error: null,
        connection: null,
      },
      session: {
        attachable: session.endedAt === null,
        started_at: session.startedAt?.toISOString() ?? null,
      },
    },
    crossed.kind === "admitted" ? crossed.value : crossed.reason,
  );
}

type RunSummaryRow = {
  id: string;
  state: string;
  agentId: string | null;
  statusReason?: string | null;
  failure?: A2ATaskFailure | null;
  createdAt: Date;
  stateChangedAt: Date | null;
};

/** `narrow` (Guardrails active) keeps free-form status text out of the result. */
function runSummary(params: {
  row: RunSummaryRow;
  runId: string;
  narrow?: boolean;
}) {
  const { row } = params;
  return {
    run_id: params.runId,
    state: displayState(row.state),
    agent_id: row.agentId,
    status_reason: modelFacingStatusReason(
      row.statusReason,
      params.narrow ?? false,
    ),
    // A bounded identifier (platform vocabulary or an image envelope code),
    // not free-form run text, so it stays visible under Guardrails.
    failure:
      row.state === "TASK_STATE_FAILED" && row.failure ? row.failure : null,
    created_at: row.createdAt.toISOString(),
    state_changed_at: (row.stateChangedAt ?? row.createdAt).toISOString(),
  };
}

/**
 * A status reason can be a raw error message carrying data from the run, so
 * under Guardrails the model only learns that one exists.
 */
function modelFacingStatusReason(
  reason: string | null | undefined,
  narrow: boolean,
): string | null {
  if (!reason) return null;
  return narrow ? WITHHELD_STATUS_REASON : reason;
}

const WITHHELD_STATUS_REASON =
  "Details are withheld under Guardrails; a person can read them on the run page.";

function describeProtocolState(task: { status: { state?: string } }): string {
  return displayState(task.status.state);
}

/** "TASK_STATE_INPUT_REQUIRED" → "input-required"; unknown values pass through. */
function displayState(state: string | undefined): string {
  if (!state) return "unknown";
  return state
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replaceAll("_", "-");
}

const FRIENDLY_TO_PROTOCOL_STATE = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
} as const;
