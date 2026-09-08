import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentCard,
  type Message,
  Role,
  type SendMessageResult,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import {
  type Client,
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import type { ArchestraContext } from "@/archestra-mcp-server/types";
import logger from "@/logging";
import { A2aConnectionModel, A2aOutboundRunModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type {
  A2aConnection,
  A2aOutboundRunState,
  A2aRemoteAgent,
  Tool,
} from "@/types";
import { safeA2aFetch } from "./a2a-outbound-registry";

const OUTPUT_MODES = ["text/plain", "application/json"];
const A2A_EXECUTION_TIMEOUT_MS = 5 * 60_000;
const A2A_POLL_INTERVAL_MS = 250;

class OutboundA2aOutcomeError extends Error {
  constructor(
    readonly state: A2aOutboundRunState,
    message: string,
  ) {
    super(message);
    this.name = "OutboundA2aOutcomeError";
  }
}

type OutboundA2aTarget = {
  remoteAgent: A2aRemoteAgent;
  connection: A2aConnection;
  tool: Tool;
};

/**
 * Send one bounded, blocking A2A message to an explicitly assigned external
 * agent. Only the tool's `message` argument crosses the trust boundary; parent
 * prompts, conversation history, and inbound credentials are never forwarded.
 */
export async function executeOutboundA2aDelegation(params: {
  target: OutboundA2aTarget;
  message: string;
  context: ArchestraContext;
}): Promise<string> {
  const { target, message, context } = params;
  if (!context.organizationId || !context.agentId) {
    throw new Error(
      "Outbound A2A delegation requires agent and organization context",
    );
  }
  if (!target.connection.enabled) {
    throw new Error("This outbound A2A connection is disabled");
  }

  const messageId = randomUUID();
  const run = await A2aOutboundRunModel.create({
    organizationId: context.organizationId,
    parentAgentId: context.agentId,
    remoteAgentId: target.remoteAgent.id,
    connectionId: target.connection.id,
    toolId: target.tool.id,
    userId:
      context.userId && context.userId !== "system" ? context.userId : null,
    conversationId: context.conversationId ?? null,
    toolCallId: context.currentToolCallId ?? null,
    messageId,
    state: "pending",
    targetNameSnapshot: target.remoteAgent.name,
    interfaceSnapshot: target.connection.selectedInterface,
  });
  let client: Client | null = null;
  let activeTaskId: string | null = null;
  const executionTimeout = AbortSignal.timeout(A2A_EXECUTION_TIMEOUT_MS);
  const executionSignal = context.abortSignal
    ? AbortSignal.any([context.abortSignal, executionTimeout])
    : executionTimeout;

  try {
    const fetchImpl = await buildAuthenticatedFetch(target.connection);
    const options = ClientFactoryOptions.createFrom(
      ClientFactoryOptions.default,
      {
        preferredTransports: [
          target.connection.selectedInterface.protocolBinding,
        ],
        transports: [
          new JsonRpcTransportFactory({ fetchImpl }),
          new RestTransportFactory({ fetchImpl }),
        ],
      },
    );
    client = await new ClientFactory(options).createFromAgentCard(
      cardPinnedToSelectedInterface(target),
    );
    let result = await client.sendMessage(
      {
        tenant: target.connection.selectedInterface.tenant ?? "",
        message: {
          messageId,
          contextId: "",
          taskId: "",
          role: Role.ROLE_USER,
          parts: [
            {
              content: { $case: "text", value: message },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain",
            },
          ],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: {
          acceptedOutputModes: OUTPUT_MODES,
          taskPushNotificationConfig: undefined,
          // Receive and persist the remote task identity promptly, then poll
          // through the SDK. A remote agent is allowed to outlive one HTTP
          // request; the overall delegation still has a bounded deadline.
          returnImmediately: true,
        },
        metadata: undefined,
      },
      { signal: executionSignal },
    );

    let outcome = normalizeResult(result);
    if (isTask(result) && !isTerminalState(outcome.state)) {
      activeTaskId = result.id;
      await updateRunFromOutcome(run.id, outcome);
      result = await pollTaskToTerminal({
        client,
        task: result,
        tenant: target.connection.selectedInterface.tenant ?? "",
        signal: executionSignal,
        onProgress: async (task) => {
          await updateRunFromOutcome(run.id, normalizeResult(task));
        },
      });
      outcome = normalizeResult(result);
    }
    activeTaskId = null;
    await A2aOutboundRunModel.update(run.id, {
      remoteTaskId: outcome.remoteTaskId,
      remoteContextId: outcome.remoteContextId,
      state: outcome.state,
      statusReason: outcome.statusReason,
      errorCode:
        outcome.state === "completed" ? null : `remote_${outcome.state}`,
      completedAt: isTerminalState(outcome.state) ? new Date() : null,
    });

    logger.info(
      {
        runId: run.id,
        parentAgentId: context.agentId,
        remoteAgentId: target.remoteAgent.id,
        connectionId: target.connection.id,
        state: outcome.state,
      },
      "Outbound A2A delegation completed",
    );

    if (outcome.state !== "completed") {
      throw new OutboundA2aOutcomeError(
        outcome.state,
        outcome.statusReason ?? `Outbound A2A agent returned ${outcome.state}`,
      );
    }
    await A2aConnectionModel.update(target.connection.id, {
      lastVerifiedAt: new Date(),
      lastVerificationError: null,
    }).catch(() => {});
    return outcome.text || "The external agent returned no text or data.";
  } catch (error) {
    if (client && activeTaskId) {
      await client
        .cancelTask(
          {
            tenant: target.connection.selectedInterface.tenant ?? "",
            id: activeTaskId,
            metadata: undefined,
          },
          { signal: AbortSignal.timeout(5_000) },
        )
        .catch(() => {});
    }
    // A protocol response was already persisted with its precise remote state
    // and identifiers. Transport/SDK failures have no such outcome and become
    // a local failed run instead.
    if (!(error instanceof OutboundA2aOutcomeError)) {
      await A2aOutboundRunModel.update(run.id, {
        state: "failed",
        errorCode: errorCode(error),
        statusReason: safeErrorMessage(error),
        completedAt: new Date(),
      }).catch(() => {});
    }
    logger.error(
      {
        errorCode: errorCode(error),
        errorMessage: safeErrorMessage(error),
        runId: run.id,
        parentAgentId: context.agentId,
        remoteAgentId: target.remoteAgent.id,
        connectionId: target.connection.id,
      },
      "Outbound A2A delegation failed",
    );
    throw error;
  }
}

async function pollTaskToTerminal(params: {
  client: Client;
  task: Task;
  tenant: string;
  signal: AbortSignal;
  onProgress: (task: Task) => Promise<void>;
}): Promise<Task> {
  let task = params.task;
  while (!isTerminalState(taskState(task.status?.state))) {
    await delay(A2A_POLL_INTERVAL_MS, undefined, { signal: params.signal });
    task = await params.client.getTask(
      { tenant: params.tenant, id: task.id, historyLength: 10 },
      { signal: params.signal },
    );
    await params.onProgress(task);
  }
  return task;
}

async function updateRunFromOutcome(
  runId: string,
  outcome: ReturnType<typeof normalizeResult>,
): Promise<void> {
  await A2aOutboundRunModel.update(runId, {
    remoteTaskId: outcome.remoteTaskId,
    remoteContextId: outcome.remoteContextId,
    state: outcome.state,
    statusReason: outcome.statusReason,
    errorCode: null,
    completedAt: null,
  });
}

async function buildAuthenticatedFetch(
  connection: A2aConnection,
): Promise<typeof fetch> {
  if (connection.authType === "none") return safeA2aFetch;
  if (!connection.secretId) {
    throw new Error("Outbound A2A credential is missing");
  }
  const stored = await secretManager().getSecret(connection.secretId);
  const secret = stored?.secret as Record<string, unknown> | null;
  const credential = secret?.credential;
  if (typeof credential !== "string" || !credential) {
    throw new Error("Outbound A2A credential is unreadable");
  }

  const headerName =
    connection.authType === "bearer"
      ? "authorization"
      : connection.authConfig.headerName;
  if (!headerName) throw new Error("Outbound A2A API-key header is missing");
  const headerValue =
    connection.authType === "bearer" ? `Bearer ${credential}` : credential;

  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(headerName, headerValue);
    return safeA2aFetch(input, { ...init, headers });
  };
}

function cardPinnedToSelectedInterface(target: OutboundA2aTarget): AgentCard {
  return {
    ...(structuredClone(target.remoteAgent.agentCard) as unknown as AgentCard),
    supportedInterfaces: [
      {
        ...target.connection.selectedInterface,
        tenant: target.connection.selectedInterface.tenant ?? "",
      },
    ],
  };
}

function normalizeResult(result: SendMessageResult): {
  text: string;
  state: A2aOutboundRunState;
  remoteTaskId: string | null;
  remoteContextId: string | null;
  statusReason: string | null;
} {
  if (isTask(result)) {
    const state = taskState(result.status?.state);
    const statusText = result.status?.message
      ? partsToText(result.status.message.parts).slice(0, 2_000)
      : "";
    const artifactText = result.artifacts
      .flatMap((artifact) => partsToText(artifact.parts))
      .filter(Boolean)
      .join("\n");
    const historyText = [...result.history]
      .reverse()
      .find((message) => message.role === Role.ROLE_AGENT);
    return {
      text: artifactText || statusText || partsToText(historyText?.parts ?? []),
      state,
      remoteTaskId: result.id || null,
      remoteContextId: result.contextId || null,
      statusReason: statusText || null,
    };
  }

  return {
    text: partsToText(result.parts),
    state: "completed",
    remoteTaskId: result.taskId || null,
    remoteContextId: result.contextId || null,
    statusReason: null,
  };
}

function partsToText(parts: Message["parts"]): string {
  return parts
    .flatMap((part) => {
      if (part.content?.$case === "text") return [part.content.value];
      if (part.content?.$case === "data") {
        return [JSON.stringify(part.content.value)];
      }
      if (part.content?.$case === "url") return [part.content.value];
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

function isTask(result: SendMessageResult): result is Task {
  return "id" in result && "status" in result;
}

function taskState(state: TaskState | undefined): A2aOutboundRunState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input_required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth_required";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    default:
      return "unknown";
  }
}

function isTerminalState(state: A2aOutboundRunState): boolean {
  return [
    "completed",
    "failed",
    "canceled",
    "input_required",
    "auth_required",
    "rejected",
  ].includes(state);
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "aborted";
  }
  if (error instanceof Error && error.name) return error.name;
  return "unknown";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 2_000)
    : "Unknown error";
}
