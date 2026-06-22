import type { ToolExecutionOptions } from "ai";
import { evaluateIfContextIsTrusted } from "@/guardrails/trusted-data";
import { AgentTeamModel } from "@/models";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";
import type {
  CommonMessage,
  GlobalToolPolicy,
  UnsafeContextBoundary,
} from "@/types";

// === Exports ===

export async function evaluateToolExecutionContextTrust(params: {
  messages: ToolExecutionOptions["messages"];
  agentId: string;
  organizationId: string;
  userId: string;
  considerContextUntrusted: boolean;
  globalToolPolicy: GlobalToolPolicy;
  policyContext: Omit<PolicyEvaluationContext, "teamIds">;
}): Promise<{
  contextIsTrusted: boolean;
  unsafeContextBoundary?: UnsafeContextBoundary;
}> {
  const commonMessages = toCommonMessages(params.messages);
  const teamIds = await AgentTeamModel.getTeamsForAgent(params.agentId);
  const evaluation = await evaluateIfContextIsTrusted(
    commonMessages,
    params.agentId,
    params.organizationId,
    params.userId,
    params.considerContextUntrusted,
    params.globalToolPolicy,
    {
      ...params.policyContext,
      teamIds,
    },
  );

  return {
    contextIsTrusted: evaluation.contextIsTrusted,
    unsafeContextBoundary: evaluation.unsafeContextBoundary,
  };
}

// === Internal Helpers ===

function toCommonMessages(
  messages: ToolExecutionOptions["messages"],
): CommonMessage[] {
  return (messages ?? []).map((message) => {
    const commonMessage: CommonMessage = {
      role: normalizeMessageRole(message.role),
    };

    const textContent = extractMessageText(message.content);
    if (textContent) {
      commonMessage.content = textContent;
    }

    const toolCalls = extractToolResults(message.content) ?? [];
    if (toolCalls.length > 0) {
      commonMessage.toolCalls = toolCalls;
    }

    return commonMessage;
  });
}

function extractToolResults(content: unknown): CommonMessage["toolCalls"] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "tool-result") {
      return [];
    }

    const toolCallId =
      typeof part.toolCallId === "string" ? part.toolCallId : null;
    const toolName = typeof part.toolName === "string" ? part.toolName : null;

    if (!toolCallId || !toolName) {
      return [];
    }

    const isError = typeof part.isError === "boolean" ? part.isError : false;
    const output =
      "output" in part ? normalizeToolResultOutput(part.output) : undefined;

    return [
      {
        id: toolCallId,
        name: toolName,
        content: output,
        isError,
        ...(isError && typeof output === "string" ? { error: output } : {}),
      },
    ];
  });
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .flatMap((part) => {
      if (!isRecord(part)) {
        return [];
      }

      if (part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }

      return [];
    })
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
}

function normalizeMessageRole(role: unknown): CommonMessage["role"] {
  switch (role) {
    case "assistant":
    case "tool":
    case "system":
    case "model":
    case "function":
      return role;
    default:
      return "user";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToolResultOutput(output: unknown): unknown {
  if (!isRecord(output) || typeof output.type !== "string") {
    return output;
  }

  switch (output.type) {
    case "json":
    case "text":
    case "error-text":
    case "error-json":
      return output.value;
    default:
      return output;
  }
}
