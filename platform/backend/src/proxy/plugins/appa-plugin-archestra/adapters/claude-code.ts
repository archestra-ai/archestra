import { EXTERNAL_AGENT_ID_HEADER } from "@archestra/shared/consts";
import { isClaudeDesktopClientAgentId } from "@archestra/shared/interactions/client";
import { verifyChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { type AppaSessionIdentity, declaredToolEntries } from "@/openappa/wire";
import { parseClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import { ApiError } from "@/types";
import type { CommonToolResult } from "@/types/common-llm-format";
import { asRecord } from "@/utils/as-record";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaRelayArrival,
  AppaRelayMessage,
  AppaRelayRecipient,
  AppaSpawnPromptField,
  AppaTeammateLaunch,
  AskUserArguments,
  NativeQuestionResult,
} from "../types";
import { questionHeader, readHeader } from "../utils";
import {
  admitClaudeCodeRelayReport,
  claudeCodeRelayArrivals,
  isClaudeCodeRelayReceipt,
} from "./claude-code-relay";
import { structuredQuestionRuling } from "./native-question-ruling";
import {
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
  nativeId,
  stringField,
  stripRecordFields,
} from "./trajectory";

/** Reads native identity signals without composing or binding a trajectory. */
export function claudeCodeNativeChildIds(context: AppaMatchContext): {
  parentNativeId: string | undefined;
  childNativeId: string | undefined;
} {
  return {
    parentNativeId: parentSessionId(context),
    childNativeId: childAgentId(context),
  };
}

/** Whether an adapter id belongs to the Claude Code / Claude Desktop family. */
export function isClaudeCodeFamilyAdapter(
  id: string | undefined,
): id is "claude-code" | "claude-desktop" {
  return id === "claude-code" || id === "claude-desktop";
}

/** A skill runs in the spawner's trajectory. An agent opens a new child trajectory. */
const CHILD_SPAWN_TOOLS = new Set(["Agent", "Task"]);
const HANDBACK_TOOLS = new Set(["SubagentHandback"]);
const HANDBACK_VALUE_KEYS = ["message", "result", "content", "output"] as const;
const CHILD_PATHS = [
  { prefix: "tasks/", suffix: ".output" },
  { prefix: "subagents/agent-", suffix: ".jsonl" },
] as const;
const ASYNC_LAUNCH_STATUS = "Async agent launched successfully.";
// Claude returns this client status when its handback retries are exhausted.
// No child output crossed, and SendMessage can still resume the child.
const NO_HANDBACK_STATUS =
  "The subagent ended without delivering a report through SubagentHandback, so no report was delivered.";
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
  readonly id: "claude-code" | "claude-desktop" = "claude-code";
  readonly trajectoryPrefix: string = "cc";
  protected readonly provenance: {
    header: NonNullable<AppaSessionIdentity["provenance"]>;
    metadata: NonNullable<AppaSessionIdentity["provenance"]>;
  } = {
    header: "claude-code-header",
    metadata: "claude-code-metadata",
  };
  readonly childTranscriptPaths = CHILD_PATHS;
  readonly nativeQuestion = {
    toolName: "AskUserQuestion",
    // A review shows its call in each option's preview, inside the form, and
    // asks one line about it.
    fromAskUser: (args: AskUserArguments) => {
      const previews = showsCallPreview(args);
      return {
        questions: [
          {
            question: shownQuestion(args),
            // Claude Code's AskUserQuestion tab label is at most 12 characters.
            header: questionHeader(args.header, 12),
            options: args.options.map((option) => ({
              label: option.label,
              description: option.description ?? option.label,
              ...(previews
                ? { preview: option.preview ?? args.callPreview }
                : {}),
            })),
            multiSelect: args.allowMultiple === true,
          },
        ],
      };
    },
    rulingFromResult: (result: NativeQuestionResult, asked: AskUserArguments) =>
      structuredQuestionRuling(result, shownQuestion(asked)),
    formFallback: true,
  };
  // Claude Code connects MCP servers in the background and declares this tool
  // in the requests it sends before they are ready.
  readonly pendingServersTool = "WaitForMcpServers";
  // Observed on 2.1.310: "No such tool available" comes back as an error result.
  readonly answersUndeclaredCalls = true;
  // A gateway that needs a sign-in is not pending, so the wait tool is not
  // declared and never carries the denial: /mcp is where the person sees that.
  gatewayToolsHint(serverName: string): string {
    return `Run /mcp in Claude Code. If "${serverName}" is still connecting, wait for it. If it needs authentication, select it and sign in. If it is not listed, connect Claude Code again and start a new session. Then send your message again.`;
  }
  matches(context: AppaMatchContext): boolean {
    if (isClaudeDesktopSignal(context)) return false;
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
    if (sessionId) return { sessionId, provenance: this.provenance.header };
    const userId = stringField(
      asRecord(asRecord(context.requestBody)?.metadata)?.user_id,
    );
    const metadataSession = parseClaudeMetadataSessionId(userId);
    return metadataSession
      ? { sessionId: metadataSession, provenance: this.provenance.metadata }
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
  ): { name?: string; childNativeId: string } | undefined {
    if (!text.startsWith(TEAMMATE_LAUNCH_STATUS)) {
      const identifier = childLaunchIdentifier(text);
      return identifier?.label === "agentId"
        ? { childNativeId: identifier.value }
        : undefined;
    }
    const id = /^agent_id:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
    const name = /^name:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
    if (!id || !name || !isChildId(id) || !isChildId(name)) return undefined;
    if (id !== name && !id.startsWith(`${name}@`)) return undefined;
    return { name, childNativeId: id };
  }

  teammateLaunches(requestBody: unknown): Map<string, AppaTeammateLaunch> {
    const launches = new Map<string, AppaTeammateLaunch>();
    for (const { text, callId, teammate } of spawnResultTexts(requestBody)) {
      if (!text.startsWith(TEAMMATE_LAUNCH_STATUS)) {
        const identifier = childLaunchIdentifier(text);
        if (identifier?.label === "agentId" && isChildId(teammate)) {
          launches.set(teammate, {
            childNativeId: identifier.value,
            spawnCallId: callId,
          });
        }
        continue;
      }
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
    const raw = typeof args === "string" ? args : undefined;
    const parsed = raw ? parseJson(raw) : undefined;
    const record = asRecord(args) ?? asRecord(parsed);
    if (!record) return raw;
    for (const key of HANDBACK_VALUE_KEYS) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  }

  rewriteChildHandback(
    args: unknown,
    admitted: string,
  ): string | Record<string, unknown> {
    const raw = typeof args === "string" ? args : undefined;
    const parsed = raw ? parseJson(raw) : undefined;
    const record = asRecord(args) ?? asRecord(parsed);
    if (!record) return admitted;
    const key =
      HANDBACK_VALUE_KEYS.find(
        (candidate) => typeof record[candidate] === "string",
      ) ?? "message";
    const rewritten = { [key]: admitted };
    return typeof args === "string" ? JSON.stringify(rewritten) : rewritten;
  }

  normalizeChildLaunchResult(result: CommonToolResult): string | undefined {
    if (!CHILD_SPAWN_TOOLS.has(localToolName(result.name)) || result.isError)
      return undefined;
    const identifier = childLaunchIdentifier(result.content);
    const status = launchText(result.content)?.startsWith(NO_HANDBACK_STATUS)
      ? NO_HANDBACK_STATUS
      : ASYNC_LAUNCH_STATUS;
    return identifier
      ? `${status}\n${identifier.label}: ${identifier.value}`
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

/**
 * Identifies Claude Desktop requests. Claude Desktop's Code and Cowork tabs
 * share Claude Code's runtime, tool names (`Bash`, `Agent`, `SendMessage`,
 * `AskUserQuestion`, `WaitForMcpServers`), and session/subagent wire format.
 * Its differences are identity (`anthropic_claude_desktop` agent id header,
 * `claude-desktop` User-Agent, or a `cowork`/`claude-desktop` Anthropic billing
 * entrypoint in the system prompt), gateway setup instructions, and native
 * question rendering/answer matching.
 */
export class AppaClaudeDesktopAdapter extends AppaClaudeCodeAdapter {
  override readonly id = "claude-desktop" as const;
  override readonly trajectoryPrefix = "claude-desktop";
  protected override readonly provenance = {
    header: "claude-desktop-header",
    metadata: "claude-desktop-metadata",
  } as const;
  // Claude Desktop's Code tab omits `option.preview` entirely, and its Cowork
  // tab sanitizes HTML-like substrings inside `option.preview` via DOMPurify
  // and hides the preview pane on narrow widths. Asking the full question
  // without `option.preview` renders the call and policy scope as literal
  // `whitespace-pre-wrap` text across both tabs and keeps single-click choice
  // submission enabled.
  override readonly nativeQuestion = {
    toolName: "AskUserQuestion",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: args.question,
          header: questionHeader(args.header, 12),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiSelect: args.allowMultiple === true,
        },
      ],
    }),
    rulingFromResult: (result: NativeQuestionResult, asked: AskUserArguments) =>
      structuredQuestionRuling(result, asked.question),
    formFallback: true,
  };

  override gatewayToolsHint(serverName: string): string {
    return `In Claude Desktop, open Settings → Connectors, select "${serverName}", and complete sign-in if needed. In your conversation, open + → Connectors and enable "${serverName}" if it is off. If it is not listed, connect Claude Desktop again and start a new session. Then send your message again.`;
  }

  override matches(context: AppaMatchContext): boolean {
    return (
      isClaudeDesktopSignal(context) &&
      (context.trustedContext !== undefined ||
        this.extractSessionIdentity(context) !== undefined ||
        isToolFreeDesktopRequest(context.requestBody))
    );
  }

  override extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const headerSession =
      readHeader(context.headers, "x-claude-code-session-id")?.trim() ??
      readHeader(context.headers, "x-claude-desktop-session-id")?.trim() ??
      readHeader(context.headers, "x-claude-desktop-conversation-id")?.trim();
    if (headerSession) {
      return { sessionId: headerSession, provenance: this.provenance.header };
    }
    const conversationId = extractDesktopConversationId(context);
    return conversationId
      ? { sessionId: conversationId, provenance: this.provenance.metadata }
      : undefined;
  }
}

const CLAUDE_DESKTOP_BILLING_ENTRYPOINT_RE =
  /cc_entrypoint=(?:cowork|claude-desktop(?:-3p)?|local[-_]agent|remote[-_](?:cowork(?:_trigger)?|desktop)|claude-coworker(?:-terminal)?)(?=[;\s]|$)/i;

function isClaudeDesktopSignal(context: AppaMatchContext): boolean {
  const userAgent = (
    readHeader(context.headers, "user-agent") ?? ""
  ).toLowerCase();
  return (
    isClaudeDesktopClientAgentId(
      readHeader(context.headers, EXTERNAL_AGENT_ID_HEADER),
    ) ||
    userAgent.includes("claude-desktop") ||
    userAgent.includes("claudedesktop") ||
    hasClaudeDesktopBillingEntrypoint(context.requestBody)
  );
}

/**
 * Claude Desktop's main process and older connection installers send one-shot
 * tool-free Messages requests (gateway probes, session title generation)
 * without a conversation or session identifier. Because they declare no tools
 * and carry no tool calls/results or provider thread state, OpenAPPA never
 * opens a governed session for them; matching them avoids blocking Desktop
 * startup or connection setup when unrecognized clients are blocked.
 */
function isToolFreeDesktopRequest(requestBody: unknown): boolean {
  const body = asRecord(requestBody);
  if (
    !body ||
    !Array.isArray(body.messages) ||
    body.thread !== undefined ||
    body.container !== undefined ||
    declaredToolEntries(requestBody).length > 0
  ) {
    return false;
  }
  for (const message of body.messages) {
    const content = asRecord(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = asRecord(part)?.type;
      if (type === "tool_use" || type === "tool_result") {
        return false;
      }
    }
  }
  return true;
}

function hasClaudeDesktopBillingEntrypoint(requestBody: unknown): boolean {
  const system = asRecord(requestBody)?.system;
  const text =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? system
            .map((block) => stringField(asRecord(block)?.text) ?? "")
            .join("\n")
        : "";
  return (
    text.toLowerCase().includes("x-anthropic-billing-header") &&
    CLAUDE_DESKTOP_BILLING_ENTRYPOINT_RE.test(text)
  );
}

/**
 * Extracts a client-supplied per-conversation or per-session identifier from
 * a Claude Desktop request body without deriving identity from prompt content.
 * Rejects contradictory conversation metadata claims.
 */
function extractDesktopConversationId(
  context: AppaMatchContext,
): string | undefined {
  const body = asRecord(context.requestBody);
  if (!body) return undefined;
  const metadata = asRecord(body.metadata);
  const userMetadata = claudeUserMetadata(context);
  const candidates = [
    parseClaudeMetadataSessionId(stringField(metadata?.user_id)) ?? undefined,
    stringField(userMetadata?.conversation_id)?.trim(),
    stringField(metadata?.session_id)?.trim(),
    stringField(metadata?.conversation_id)?.trim(),
    stringField(body.conversation_id)?.trim(),
    stringField(body.conversation)?.trim(),
  ].filter((value): value is string => Boolean(value));
  const [first] = candidates;
  if (!first) return undefined;
  if (candidates.some((candidate) => candidate !== first)) {
    throw new ApiError(
      400,
      "OpenAPPA cannot bind contradictory Claude Desktop conversation metadata",
    );
  }
  return first;
}

/**
 * A review whose call each option previews, so the form can ask in one line.
 * AskUserQuestion shows previews for single-select questions only, and the
 * terminal withholds a preview that is too long or has control characters.
 * If any preview would be withheld, the review asks the full question, which
 * carries the call itself.
 */
function showsCallPreview(
  args: AskUserArguments,
): args is AskUserArguments & { callPreview: string; shortQuestion: string } {
  return (
    args.allowMultiple !== true &&
    typeof args.callPreview === "string" &&
    showablePreview(args.callPreview) &&
    args.options.every(
      (option) =>
        option.preview === undefined || showablePreview(option.preview),
    ) &&
    typeof args.shortQuestion === "string"
  );
}

function showablePreview(preview: string): boolean {
  return (
    preview.length <= PREVIEW_MAX_LENGTH && !CONTROL_CHARACTERS.test(preview)
  );
}

/** The longest option preview Claude Code shows instead of withholding it. */
const PREVIEW_MAX_LENGTH = 2000;
/** Control characters other than tab and newline. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the characters are what this matches
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** The question text Claude Code shows, and repeats before the answer. */
function shownQuestion(args: AskUserArguments): string {
  return showsCallPreview(args) ? args.shortQuestion : args.question;
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Claude Desktop's Code tab omits `option.preview` from AskUserQuestion cards,
 * and its Cowork tab sanitizes HTML-like substrings inside `option.preview` and
 * hides the preview pane on narrow widths. Combining the inspectable card's
 * title and bounded plain-text preview into `question` shows the call and
 * policy scope verbatim across both tabs.
 */
export function claudeDesktopReviewQuestion(card: AskUserArguments): string {
  const title = card.shortQuestion ?? card.question;
  const preview =
    card.options.find((option) => option.label === "Allow")?.preview ??
    card.callPreview;
  return preview ? `${title}\n\n${preview}` : title;
}
// SPDX-SnippetEnd

function parentSessionId(context: AppaMatchContext): string | undefined {
  const metadata = claudeUserMetadata(context);
  const description = "Claude Code parent session id";
  // A present invalid parent is a broken claim, not permission to fall back.
  if (metadata && "parent_session_id" in metadata) {
    return nativeId(metadata.parent_session_id, description);
  }
  const header = readHeader(context.headers, "x-claude-code-session-id");
  if (header !== undefined) return nativeId(header, description);
  if (metadata && "session_id" in metadata) {
    return nativeId(metadata.session_id, description);
  }
  const userId = asRecord(asRecord(context.requestBody)?.metadata)?.user_id;
  return nativeId(
    typeof userId === "string"
      ? (parseClaudeMetadataSessionId(userId) ?? userId)
      : userId,
    description,
  );
}

function childAgentId(context: AppaMatchContext): string | undefined {
  if (context.trustedContext?.claudeTeammateNativeId)
    return context.trustedContext.claudeTeammateNativeId;
  const description = "Claude Code child agent id";
  // A present invalid child id is a broken claim, not permission to fall back.
  const header = readHeader(context.headers, "x-claude-code-agent-id");
  if (header !== undefined) return nativeId(header, description);
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const fromMetadata = stringField(metadata?.agent_id);
  if (fromMetadata) return nativeId(fromMetadata, description);
  const userId = stringField(metadata?.user_id);
  if (userId?.trimStart().startsWith("{")) {
    let user: Record<string, unknown> | undefined;
    try {
      user = asRecord(JSON.parse(userId));
    } catch {
      // Ignore JSON parse errors
    }
    if (user) {
      const fromUser = stringField(user.agent_id);
      if (fromUser) return nativeId(fromUser, description);
      const parent = stringField(user.parent_session_id);
      const session = stringField(user.session_id);
      if (parent && session && parent !== session) {
        return nativeId(session, description);
      }
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
  if (
    !text ||
    (!text.startsWith(ASYNC_LAUNCH_STATUS) &&
      !text.startsWith(NO_HANDBACK_STATUS))
  )
    return undefined;
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
