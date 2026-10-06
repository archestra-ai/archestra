import { verifyChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { parseClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import { ApiError } from "@/types";
import type { CommonToolResult } from "@/types/common-llm-format";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaRelayArrival,
  AppaRelayMessage,
  AppaRelayRecipient,
  AppaSpawnPromptField,
  AppaTeammateLaunch,
  AskUserArguments,
} from "../types";
import { questionHeader, readHeader } from "../utils";
import {
  admitClaudeCodeRelayReport,
  claudeCodeRelayArrivals,
  isClaudeCodeRelayReceipt,
} from "./claude-code-relay";
import { structuredQuestionRuling } from "./native-question-ruling";
import {
  asRecord,
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
  stringField,
  stripRecordFields,
} from "./trajectory";

/** A skill runs in the spawner's trajectory. An agent opens a new child trajectory. */
const CHILD_SPAWN_TOOLS = new Set(["Agent", "Task"]);
const HANDBACK_TOOLS = new Set(["SubagentHandback"]);
const HANDBACK_VALUE_KEYS = ["message", "result", "content", "output"] as const;
const CHILD_PATHS = [
  { prefix: "tasks/", suffix: ".output" },
  { prefix: "subagents/agent-", suffix: ".jsonl" },
] as const;
const ASYNC_LAUNCH_STATUS = "Async agent launched successfully.";
/**
 * The Agent tool also acknowledges a teammate and a cloud agent when they
 * start. Like the background launch, these carry no child output: the child
 * reports later, so no retained return exists for them.
 */
const TEAMMATE_LAUNCH_STATUS = "Spawned successfully.";
const LAUNCH_ACKNOWLEDGEMENTS = [
  { status: TEAMMATE_LAUNCH_STATUS, labels: ["agent_id", "name"] },
  { status: "Cloud agent launched.", labels: ["taskId"] },
] as const;
/** Claude Code's messages between a lead, its teammates, and other agents. */
const RELAY_TOOLS = new Set(["SendMessage"]);
/**
 * The names a child uses for the agent that started it: a teammate's lead,
 * and the main conversation a background subagent reports to.
 */
const PARENT_NAMES = new Set(["team-lead", "main"]);
/** Explicit addresses of another session: a socket, a bridge, or a listed name with its ref. */
const SESSION_ADDRESS =
  /^(?:uds:|bridge:|local_|\/|\\\\\.\\pipe\\)|\s\[[0-9a-f]{6,12}\]$/;
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
   * Extracts the native session ID from Claude Code headers or metadata.
   * Claude Code sends the same session ID across resumes and `/compact` continuations.
   * Forks use replayed trajectory stamps to continue on the parent root.
   */
  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const sessionId = readHeader(context.headers, "x-claude-code-session-id");
    if (sessionId) return { sessionId, provenance: "claude-code-header" };
    const userId = stringField(
      asRecord(asRecord(context.requestBody)?.metadata)?.user_id,
    );
    const metadataSession = parseClaudeMetadataSessionId(userId);
    return metadataSession
      ? { sessionId: metadataSession, provenance: "claude-code-metadata" }
      : undefined;
  }

  isSpawnTool(name: string): boolean {
    return CHILD_SPAWN_TOOLS.has(localToolName(name));
  }

  relayMessage(call: {
    name: string;
    arguments: unknown;
  }): AppaRelayMessage | undefined {
    if (!RELAY_TOOLS.has(localToolName(call.name))) return undefined;
    const args = argumentRecord(call.arguments);
    const to = stringField(args?.to)?.trim();
    const message = args?.message;
    // An empty message carries nothing to cross. Claude Code refuses one
    // unless it only subscribes to an idle notice, and a crossing with no
    // output would end the sender's branch for good.
    if (!to || message === undefined || message === null || message === "")
      return undefined;
    return {
      to: relayRecipient(to),
      value: typeof message === "string" ? message : JSON.stringify(message),
      structured: typeof message !== "string",
    };
  }

  isRelayTool(name: string): boolean {
    return RELAY_TOOLS.has(localToolName(name));
  }

  isRelayReceipt(content: unknown): boolean {
    return isClaudeCodeRelayReceipt(content);
  }

  admitRelayReport(
    content: unknown,
    records: readonly string[],
  ): { content: unknown; withheld: boolean } {
    return admitClaudeCodeRelayReport(content, records);
  }

  rewriteRelayMessage(args: unknown, value: string): string {
    // The sender's summary previews the message it replaced. Without one,
    // Claude Code previews the first line of the message it sends.
    const { summary: _summary, ...rest } = argumentRecord(args) ?? {};
    return JSON.stringify({ ...rest, message: value });
  }

  relayArrivals(requestBody: unknown): AppaRelayArrival[] {
    return claudeCodeRelayArrivals(requestBody);
  }

  launchIdentity(
    text: string,
  ): { name: string; childNativeId: string } | undefined {
    if (!text.startsWith(TEAMMATE_LAUNCH_STATUS)) return undefined;
    const id = /^agent_id:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
    const name = /^name:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
    if (!id || !name || !isChildId(id) || !isChildId(name)) return undefined;
    if (id !== name && !id.startsWith(`${name}@`)) return undefined;
    return { name, childNativeId: id };
  }

  teammateLaunches(requestBody: unknown): Map<string, AppaTeammateLaunch> {
    const launches = new Map<string, AppaTeammateLaunch>();
    for (const { text, callId, teammate } of spawnResultTexts(requestBody)) {
      if (!text.startsWith(TEAMMATE_LAUNCH_STATUS)) continue;
      const id = /^agent_id:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
      const name = /^name:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
      if (id && name === teammate && isChildId(id) && isChildId(name))
        launches.set(name, { childNativeId: id, spawnCallId: callId });
    }
    return launches;
  }

  /** Claude Code names a teammate `<name>@<team>`; a subagent's id has no `@`. */
  isTeammate(childNativeId: string): boolean {
    return childNativeId.includes("@");
  }

  teammateName(call: { name: string; arguments: unknown }): string | undefined {
    if (!CHILD_SPAWN_TOOLS.has(localToolName(call.name))) return undefined;
    const name = stringField(argumentRecord(call.arguments)?.name)?.trim();
    return name && isChildId(name) ? name : undefined;
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
      : launchAcknowledgement(result.content);
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
    // In-process children share the lead's conversation; split-pane teammates
    // have their own conversation and separately report parent_session_id.
    return (
      this.extractSessionIdentity(context)?.sessionId ??
      parentSessionId(context)
    );
  }

  /** Native parent signal used to keep delegated children out of fork tracing. */
  nativeSpawnParentId(
    context: AppaMatchContext,
    _sessionId: string,
  ): string | undefined {
    const parentNativeId = parentSessionId(context);
    const child = this.bindChildTrajectory(context);
    return child && child.sessionId !== parentNativeId
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

  /**
   * A tool's own model call, like the one WebFetch reads its page with,
   * carries the headers of the agent that ran the tool but none of that
   * agent's conversation: it declares no tools, and no verified marker or
   * receipt binds it to a spawn. It is part of the tool's run, not a turn of
   * the child, so it stays out of the child's trajectory as the lead's own
   * tool-free requests do.
   */
  bindChildTrajectory(context: AppaMatchContext) {
    const parentNativeId = parentSessionId(context);
    const nativeMetadata = claudeUserMetadata(context);
    const childNativeId = childAgentId(context);
    const sessionOnlyMetadata =
      stringField(nativeMetadata?.session_id) &&
      !stringField(nativeMetadata?.parent_session_id) &&
      !childNativeId;
    // A shared session id cannot distinguish a root from a marker-only child.
    // Do not adopt a quoted receipt; a signed opening marker may still bind it.
    const bindingContext =
      sessionOnlyMetadata && context.trustedContext
        ? {
            ...context,
            trustedContext: {
              ...context.trustedContext,
              request: {
                ...context.trustedContext.request,
                childTrajectoryReceipts: [],
              },
            },
          }
        : context;
    const child = bindMintedChildTrajectory({
      context: bindingContext,
      parentNativeId,
      childNativeId,
    });
    const trusted = context.trustedContext;
    if (
      sessionOnlyMetadata &&
      !child &&
      trusted &&
      parentNativeId &&
      trusted.request.childTrajectoryReceipts?.some((receipt) =>
        verifyChildTrajectoryReceipt({
          receipt,
          organizationId: trusted.session.organization_id,
          callerId: trusted.session.caller_id,
          spawnerNativeId: parentNativeId,
          ...(receipt.nativeConversationId !== undefined
            ? { nativeConversationId: this.nativeConversationId(context) }
            : {}),
        }),
      )
    ) {
      const error = new ApiError(
        409,
        "OpenAPPA cannot distinguish this compacted subagent from its parent session. No inference or tool action was started. Resume the correct native child session, or start a new conversation without this ambiguous history.",
      );
      error.shouldRetry = false;
      throw error;
    }
    return child?.lineage?.source === "native" &&
      isToolModelCall(context.requestBody)
      ? undefined
      : child;
  }

  stripCarrierMetadata(request: unknown): void {
    const metadata = asRecord(asRecord(request)?.metadata);
    if (!metadata) return;
    stripRecordFields(metadata, ["agent_id", "parent_session_id"]);
    const userId = stringField(metadata.user_id);
    if (!userId?.trimStart().startsWith("{")) return;
    try {
      const parsed = asRecord(JSON.parse(userId));
      if (!parsed) return;
      stripRecordFields(parsed, ["agent_id", "parent_session_id"]);
      metadata.user_id = JSON.stringify(parsed);
    } catch {
      return;
    }
  }
}

function parentSessionId(context: AppaMatchContext): string | undefined {
  const parent = stringField(claudeUserMetadata(context)?.parent_session_id);
  if (parent) return parent;
  const header = readHeader(context.headers, "x-claude-code-session-id");
  if (header) return header;
  const own = stringField(claudeUserMetadata(context)?.session_id);
  if (own) return own;
  const userId = stringField(
    asRecord(asRecord(context.requestBody)?.metadata)?.user_id,
  );
  return userId ? (parseClaudeMetadataSessionId(userId) ?? userId) : undefined;
}

function childAgentId(context: AppaMatchContext): string | undefined {
  if (context.trustedContext?.claudeTeammateNativeId)
    return context.trustedContext.claudeTeammateNativeId;
  const header = readHeader(context.headers, "x-claude-code-agent-id");
  if (header) return header;
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const fromMetadata = stringField(metadata?.agent_id);
  if (fromMetadata) return fromMetadata;
  const userId = stringField(metadata?.user_id);
  if (userId?.trimStart().startsWith("{")) {
    try {
      const user = asRecord(JSON.parse(userId));
      const fromUser = stringField(user?.agent_id);
      if (fromUser) return fromUser;
      const parent = stringField(user?.parent_session_id);
      const session = stringField(user?.session_id);
      if (parent && session && parent !== session) return session;
    } catch {
      // Ignore JSON parse errors
    }
  }
  return undefined;
}

function claudeUserMetadata(
  context: AppaMatchContext,
): Record<string, unknown> | undefined {
  const raw = stringField(
    asRecord(asRecord(context.requestBody)?.metadata)?.user_id,
  );
  if (!raw?.trimStart().startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function childLaunchIdentifier(
  content: unknown,
): { label: "agentId" | "taskId"; value: string } | undefined {
  const text = launchText(content);
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

/**
 * Keeps only the status line and the validated ids of a teammate or cloud
 * agent acknowledgement, so no other text crosses as a launch.
 */
function launchAcknowledgement(content: unknown): string | undefined {
  const text = launchText(content);
  const acknowledgement = LAUNCH_ACKNOWLEDGEMENTS.find(({ status }) =>
    text?.startsWith(status),
  );
  if (!text || !acknowledgement) return undefined;
  const lines: string[] = [acknowledgement.status];
  for (const label of acknowledgement.labels) {
    const value = new RegExp(`^${label}:[ \\t]*(\\S+)[ \\t]*$`, "m").exec(
      text,
    )?.[1];
    if (!value || !isChildId(value)) return undefined;
    lines.push(`${label}: ${value}`);
  }
  return lines.join("\n");
}

function relayRecipient(to: string): AppaRelayRecipient {
  if (PARENT_NAMES.has(to)) return { kind: "lead" };
  if (to === "*") return { kind: "broadcast" };
  if (SESSION_ADDRESS.test(to)) return { kind: "session", id: to };
  return { kind: "teammate", name: to };
}

function argumentRecord(args: unknown): Record<string, unknown> | undefined {
  const raw = stringField(args);
  return asRecord(args) ?? (raw ? asRecord(parseJson(raw)) : undefined);
}

/**
 * The text of every successful result of a model's teammate spawn in a
 * Messages request, in order, with the call it answers and the teammate name
 * that call gave. Any other tool can return text that reads like a launch
 * receipt, so only the one result of such a call counts.
 */
function spawnResultTexts(
  requestBody: unknown,
): Array<{ text: string; callId: string; teammate: string }> {
  const results: Array<{ text: string; callId: string; teammate: string }> = [];
  const spawns = new Map<string, string>();
  const messages = asRecord(requestBody)?.messages;
  for (const message of Array.isArray(messages) ? messages : []) {
    const record = asRecord(message);
    const content = record?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const part = asRecord(block);
      if (part?.type === "tool_use" && record?.role === "assistant") {
        const id = stringField(part.id);
        const name = stringField(part.name);
        const teammate = stringField(asRecord(part.input)?.name);
        if (
          id &&
          name &&
          teammate &&
          CHILD_SPAWN_TOOLS.has(localToolName(name))
        )
          spawns.set(id, teammate);
        continue;
      }
      if (part?.type !== "tool_result") continue;
      const callId = stringField(part.tool_use_id);
      const teammate = callId ? spawns.get(callId) : undefined;
      if (!callId || teammate === undefined) continue;
      spawns.delete(callId);
      if (part.is_error === true) continue;
      const text = launchText(part.content);
      if (text) results.push({ text, callId, teammate });
    }
  }
  return results;
}

/** A conversation that declares no tools: an agent's own turns always do. */
function isToolModelCall(requestBody: unknown): boolean {
  const body = asRecord(requestBody);
  const messages = body?.messages;
  const tools = body?.tools;
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    !(Array.isArray(tools) && tools.length > 0)
  );
}

function launchText(content: unknown): string | undefined {
  const block =
    Array.isArray(content) && content.length === 1
      ? asRecord(content[0])
      : undefined;
  return (
    typeof content === "string"
      ? content
      : block?.type === "text"
        ? stringField(block.text)
        : undefined
  )?.trim();
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
  if (!isChildId(value)) return undefined;
  return {
    label: field.toLowerCase().startsWith("task") ? "taskId" : "agentId",
    value,
  };
}

/** A teammate id names its team after an `@`. */
function isChildId(value: string): boolean {
  return (
    value.length <= MAX_CHILD_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
