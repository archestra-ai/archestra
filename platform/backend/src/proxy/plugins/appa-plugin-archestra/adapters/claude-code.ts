import type { AppaSessionIdentity } from "@/openappa/wire";
import { parseClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import type { CommonToolResult } from "@/types/common-llm-format";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaSpawnPromptField,
  AskUserArguments,
} from "../types";
import { questionHeader, readHeader } from "../utils";
import { structuredQuestionRuling } from "./native-question-ruling";
import {
  asRecord,
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
  stringField,
  stripRecordFields,
} from "./trajectory";

const SPAWN_TOOLS = new Set(["Agent", "Task"]);
/** A skill runs in the spawner's trajectory. An agent opens a new child trajectory. */
const CHILD_SPAWN_TOOLS = new Set(["Agent", "Task"]);
const HANDBACK_TOOLS = new Set(["SubagentHandback"]);
const HANDBACK_VALUE_KEYS = ["message", "result", "content", "output"] as const;
const CHILD_PATHS = [
  { prefix: "tasks/", suffix: ".output" },
  { prefix: "subagents/agent-", suffix: ".jsonl" },
] as const;
const ASYNC_LAUNCH_STATUS = "Async agent launched successfully.";
const MAX_CHILD_ID_LENGTH = 128;

/** Identifies Claude Code Messages requests and normalizes local tool names. */
export class AppaClaudeCodeAdapter implements AppaClientAdapter {
  readonly id = "claude-code" as const;
  readonly trajectoryPrefix = "cc";
  readonly childTranscriptPaths = CHILD_PATHS;
  readonly nativeQuestion = {
    toolName: "AskUserQuestion",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: args.question,
          // Claude Code's AskUserQuestion tab label is at most 12 characters.
          header: questionHeader(args.header, 12),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiSelect: args.allowMultiple === true,
        },
      ],
    }),
    rulingFromResult: structuredQuestionRuling,
  };
  matches(context: AppaMatchContext): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("claude-code") ||
      userAgent.includes("claude-cli") ||
      readHeader(context.headers, "x-claude-code-session-id") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp/") || name.startsWith("mcp__")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    // Older receipts used this adapter's invalid host decoration. Normalize it
    // back to Claude's native spelling so the Archestra runtime can derive it.
    return name.startsWith("host/claude-code/")
      ? name.slice("host/claude-code/".length)
      : name;
  }

  /**
   * Extracts session ID from Claude Code headers.
   * Claude Code sends the same session ID across resumes and `/compact` continuations.
   * Forks use replayed trajectory stamps to continue on the parent root.
   */
  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const sessionId = readHeader(context.headers, "x-claude-code-session-id");
    return sessionId
      ? { sessionId, provenance: "claude-code-header" }
      : undefined;
  }

  isSpawnTool(name: string): boolean {
    return SPAWN_TOOLS.has(localToolName(name));
  }

  isChildHandbackTool(name: string): boolean {
    return HANDBACK_TOOLS.has(localToolName(name));
  }

  childHandbackValue(args: unknown): string | undefined {
    const raw = stringField(args);
    const parsed = raw ? parseJson(raw) : undefined;
    const record = asRecord(args) ?? asRecord(parsed);
    if (!record) return raw;
    for (const key of HANDBACK_VALUE_KEYS) {
      const value = stringField(record[key]);
      if (value) return value;
    }
    return undefined;
  }

  rewriteChildHandback(
    args: unknown,
    admitted: string,
  ): string | Record<string, unknown> {
    const raw = stringField(args);
    const parsed = raw ? parseJson(raw) : undefined;
    const record = asRecord(args) ?? asRecord(parsed);
    if (!record) return admitted;
    const key =
      HANDBACK_VALUE_KEYS.find((candidate) => stringField(record[candidate])) ??
      "message";
    const rewritten = { [key]: admitted };
    return typeof args === "string" ? JSON.stringify(rewritten) : rewritten;
  }

  normalizeChildLaunchResult(result: CommonToolResult): string | undefined {
    if (!CHILD_SPAWN_TOOLS.has(localToolName(result.name)) || result.isError)
      return undefined;
    const identifier = childLaunchIdentifier(result.content);
    return identifier
      ? `${ASYNC_LAUNCH_STATUS}\n${identifier.label}: ${identifier.value}`
      : undefined;
  }

  isChildCompletionResult(result: CommonToolResult): boolean {
    if (!CHILD_SPAWN_TOOLS.has(localToolName(result.name)) || result.isError)
      return false;
    return this.normalizeChildLaunchResult(result) === undefined;
  }

  spawnPromptField(
    name: string,
    _args?: Record<string, unknown>,
  ): AppaSpawnPromptField | undefined {
    return CHILD_SPAWN_TOOLS.has(localToolName(name))
      ? { field: "prompt", kind: "text" }
      : undefined;
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    // Claude Code names the session at every depth.
    // Child subagents report the session as their parent.
    return parentSessionId(context);
  }

  /** Native parent signal used to keep delegated children out of fork tracing. */
  nativeSpawnParentId(
    context: AppaMatchContext,
    sessionId: string,
  ): string | undefined {
    const parentNativeId = parentSessionId(context);
    const child = this.bindChildTrajectory(context);
    return parentNativeId === sessionId &&
      child &&
      child.sessionId !== parentNativeId
      ? parentNativeId
      : undefined;
  }

  namesChildren(params: { rootId: string; arguments: unknown }): string[] {
    return namesChildrenFromArguments({
      rootId: params.rootId,
      arguments: params.arguments,
      pathPatterns: CHILD_PATHS,
    });
  }

  bindChildTrajectory(context: AppaMatchContext) {
    const parentNativeId = parentSessionId(context);
    return bindMintedChildTrajectory({
      context,
      parentNativeId,
      childNativeId: childAgentId(context),
    });
  }

  stripCarrierMetadata(request: unknown): void {
    const metadata = asRecord(asRecord(request)?.metadata);
    if (!metadata) return;
    stripRecordFields(metadata, ["agent_id"]);
    const userId = stringField(metadata.user_id);
    if (!userId?.trimStart().startsWith("{")) return;
    try {
      const parsed = asRecord(JSON.parse(userId));
      if (!parsed) return;
      stripRecordFields(parsed, ["agent_id"]);
      metadata.user_id = JSON.stringify(parsed);
    } catch {
      return;
    }
  }
}

function parentSessionId(context: AppaMatchContext): string | undefined {
  const header = readHeader(context.headers, "x-claude-code-session-id");
  if (header) return header;
  const userId = stringField(
    asRecord(asRecord(context.requestBody)?.metadata)?.user_id,
  );
  return userId ? (parseClaudeMetadataSessionId(userId) ?? userId) : undefined;
}

function childAgentId(context: AppaMatchContext): string | undefined {
  const header = readHeader(context.headers, "x-claude-code-agent-id");
  if (header) return header;
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const fromMetadata = stringField(metadata?.agent_id);
  if (fromMetadata) return fromMetadata;
  const userId = stringField(metadata?.user_id);
  if (userId?.trimStart().startsWith("{")) {
    try {
      const fromUser = stringField(asRecord(JSON.parse(userId))?.agent_id);
      if (fromUser) return fromUser;
    } catch {
      // Ignore JSON parse errors
    }
  }
  return undefined;
}

function childLaunchIdentifier(
  content: unknown,
): { label: "agentId" | "taskId"; value: string } | undefined {
  const text = typeof content === "string" ? content.trim() : undefined;
  const record =
    asRecord(content) ?? (text ? asRecord(parseJson(text)) : undefined);
  if (record?.status === "async_launched") {
    return launchIdentifierFromRecord(record);
  }
  if (!text || !text.startsWith(ASYNC_LAUNCH_STATUS)) return undefined;
  const match =
    /^(agentId|agent_id|taskId|task_id):[ \t]*([^\s()]+)(?:[ \t]+\([^\r\n]*\))?[ \t]*$/im.exec(
      text,
    );
  if (!match?.[1] || !match[2]) return undefined;
  return launchIdentifier(match[1], match[2]);
}

function launchIdentifierFromRecord(
  record: Record<string, unknown>,
): { label: "agentId" | "taskId"; value: string } | undefined {
  for (const field of ["agent_id", "agentId", "task_id", "taskId"] as const) {
    const value = stringField(record[field]);
    if (value) return launchIdentifier(field, value);
  }
  return undefined;
}

function launchIdentifier(
  field: string,
  value: string,
): { label: "agentId" | "taskId"; value: string } | undefined {
  if (
    value.length > MAX_CHILD_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    return undefined;
  }
  return {
    label: field.toLowerCase().startsWith("task") ? "taskId" : "agentId",
    value,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
