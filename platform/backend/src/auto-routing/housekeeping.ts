import { OPENCODE_AGENT_HEADER } from "@archestra/shared/consts";
import { isClaudeClientAgentId } from "@archestra/shared/interactions/client";
import {
  detectClaudeClientId,
  detectGrokClientId,
  detectKiloClientId,
  detectOpenCodeClientId,
} from "@/routes/proxy/utils/headers/client-app";
import { getHeaderValue } from "@/routes/proxy/utils/headers/meta-header";
import { detectOpenCodeFamilyTurn } from "@/routes/proxy/utils/headers/session-metadata";
import { asRecord } from "@/utils/as-record";

type AutoRoutingEndpoint = "chat_completions" | "responses";

type AutoRoutingHousekeepingReason =
  | "opencode_title"
  | "claude_auxiliary_header"
  | "title_system_prompt"
  | "progress_label_system_prompt"
  | "title_user_prompt"
  | "claude_side_frame";

/**
 * Classifies narrow, high-precision client housekeeping requests (session title
 * generation, Claude progress labels, away summaries, and Claude auxiliary side
 * turns) that should bypass scoring and sticky session pinning and run on the
 * fast tier.
 *
 * Global vetoes run before every allowlist rule and always return `null`:
 * - Requests carrying any tools.
 * - Responses requests without `store: false`, or carrying `previous_response_id`,
 *   `conversation`, `background`, encrypted replay items, or stored references.
 * - Requests carrying provider-specific prompt cache controls.
 * - Compaction requests (headers, Codex metadata, or compaction prompt prefixes).
 * - OpenCode-family subagents (`x-parent-session-id`, even under a custom
 *   `X-Archestra-Agent-Id` label).
 * - Claude `/btw` side questions.
 *
 * Inspects structured protocol fields only and never serializes the body.
 */
export function classifyAutoRoutingHousekeeping(params: {
  endpoint: AutoRoutingEndpoint;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  client: string | null;
}): AutoRoutingHousekeepingReason | null {
  const { endpoint, headers, body, client } = params;
  const bodyRecord = asRecord(body);
  const items = conversationItems(endpoint, bodyRecord);

  // Global vetoes: evaluated before any positive rule.
  if (hasTools(bodyRecord)) {
    return null;
  }
  if (endpoint === "responses" && !isStatelessResponsesRequest(bodyRecord)) {
    return null;
  }
  if (hasProviderCacheControls(bodyRecord)) {
    return null;
  }
  if (isCompactionRequest({ headers, bodyRecord, items })) {
    return null;
  }
  const openCodeTurn = detectOpenCodeFamilyTurn(headers, client ?? undefined);
  if (
    openCodeTurn?.kind === "subagent" ||
    (getHeaderValue(headers, "x-parent-session-id") !== undefined &&
      (detectOpenCodeClientId(headers) !== undefined ||
        detectKiloClientId(headers) !== undefined))
  ) {
    return null;
  }
  if (hasClaudeSideQuestion(items)) {
    return null;
  }

  // Strict high-precision allowlist.
  if (openCodeTurn?.kind === "title") {
    return "opencode_title";
  }

  const claudeProvenance = isClaudeClient(client, bodyRecord);
  if (claudeProvenance) {
    const claudeRequestClass = getHeaderValue(
      headers,
      "x-claude-code-request-class",
    );
    if (
      claudeRequestClass === "auxiliary" ||
      claudeRequestClass === "side_reply"
    ) {
      return "claude_auxiliary_header";
    }
  }

  if (!bodyRecord) {
    return null;
  }

  const singleTurnFirstText = firstTextOnlySingleTurnBlock(items);
  const effectiveSystemText = lastNonEmptySystemText(bodyRecord, items);
  if (effectiveSystemText !== null) {
    const trimmedSystem = effectiveSystemText.trimStart();
    if (
      trimmedSystem.startsWith(TITLE_SYSTEM_PROMPT_PREFIX) &&
      singleTurnFirstText !== null
    ) {
      return "title_system_prompt";
    }
    if (
      claudeProvenance &&
      trimmedSystem.startsWith(PROGRESS_LABEL_SYSTEM_PROMPT_PREFIX)
    ) {
      return "progress_label_system_prompt";
    }
  }

  if (
    singleTurnFirstText !== null &&
    matchesTitleUserPromptPrefix(singleTurnFirstText)
  ) {
    return "title_user_prompt";
  }

  if (claudeProvenance) {
    const sideFrame = lastUserSideFrame(items);
    if (
      sideFrame !== null &&
      (CLAUDE_PROGRESS_LABEL_PROMPTS.some((prompt) =>
        sideFrame.startsWith(prompt),
      ) ||
        sideFrame.startsWith(CLAUDE_AWAY_SUMMARY_PROMPT))
    ) {
      return "claude_side_frame";
    }
  }

  return null;
}

// === Internal ===

const CLAUDE_COMPACTION_INSTRUCTION =
  "Your task is to create a detailed summary of the conversation so far";
const CLAUDE_COMPACTION_CRITICAL_INSTRUCTION = `CRITICAL: Respond with TEXT ONLY. ${CLAUDE_COMPACTION_INSTRUCTION}`;
const KIMI_CODE_COMPACTION_INSTRUCTION =
  "You are about to run out of context. Create a handoff summary for the\nmodel that will resume this task after the earlier conversation is cleared.";

const TITLE_SYSTEM_PROMPT_PREFIX =
  "You write short session titles. Reply with only the tagged fields the prompt asks for.";
const PROGRESS_LABEL_SYSTEM_PROMPT_PREFIX =
  "You write a 3-5 word progress label for a background agent, from short notes about what it is doing.";

const TITLE_USER_PROMPT_PREFIXES = [
  "Please write a 5-10 word title for this conversation",
  "Please write a 5-10 word title summarizing this conversation",
  "You are coming up with a succinct title for an agent chat session based on the initial task description",
] as const;

const SYSTEM_REMINDER_PREFIX = "<system-reminder>";
const SYSTEM_REMINDER_SUFFIX = "</system-reminder>";
const CLAUDE_SIDE_QUESTION_PROMPT =
  "<system-reminder>This is a side question from the user. You must answer this question directly in a single response.";
const CLAUDE_PROGRESS_LABEL_PROMPTS = [
  "Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.",
  "Describe the agent's most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch.",
].flatMap((prompt) => [`${prompt}\nGood: `, `${prompt}\n\nGood: `]);
const CLAUDE_AWAY_SUMMARY_PROMPT =
  "The user stepped away and is coming back. Recap in under 40 words";

const TOP_LEVEL_CACHE_CONTROL_FIELDS = [
  "cachedContent",
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
  "cache_control",
  "prompt_cache_breakpoint",
] as const;

function conversationItems(
  endpoint: AutoRoutingEndpoint,
  body: Record<string, unknown> | undefined,
): unknown {
  if (!body) return undefined;
  return endpoint === "responses" ? body.input : body.messages;
}

function hasTools(body: Record<string, unknown> | undefined): boolean {
  return Array.isArray(body?.tools) && body.tools.length > 0;
}

function isStatelessResponsesRequest(
  body: Record<string, unknown> | undefined,
): boolean {
  if (!body) return false;
  if (body.store !== false) return false;
  if (
    typeof body.previous_response_id === "string" &&
    body.previous_response_id.length > 0
  ) {
    return false;
  }
  if (hasNonEmptyConversation(body.conversation)) {
    return false;
  }
  if (body.background) {
    return false;
  }
  return !hasStoredResponsesReferences(body);
}

function hasNonEmptyConversation(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 0;
  }
  const record = asRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

/** Matches `model-pool-capabilities.ts:hasStoredResponsesReferences` plus encrypted replay items. */
function hasStoredResponsesReferences(body: Record<string, unknown>): boolean {
  if (asRecord(body.prompt)?.id) return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.some((raw) => {
    const item = asRecord(raw);
    return (
      item?.type === "item_reference" ||
      ((item?.type === "reasoning" || item?.type === "compaction") &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0) ||
      (item?.type === "computer_call_output" &&
        Boolean(asRecord(item.output)?.file_id)) ||
      (item?.type === "code_interpreter_call" && Boolean(item.container_id)) ||
      (item?.type === "shell_call" &&
        responsesContainerHasState(item.environment)) ||
      responsesContentHasFile(item?.content) ||
      responsesContentHasFile(item?.output)
    );
  });
}

function responsesContainerHasState(value: unknown): boolean {
  const container = asRecord(value);
  return (
    typeof value === "string" ||
    Boolean(container?.container_id) ||
    (Array.isArray(container?.file_ids) && container.file_ids.length > 0) ||
    (Array.isArray(container?.skills) &&
      container.skills.some(
        (skill) => asRecord(skill)?.type === "skill_reference",
      ))
  );
}

function responsesContentHasFile(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((raw) => {
      const part = asRecord(raw);
      return (
        (part?.type === "input_file" || part?.type === "input_image") &&
        Boolean(part.file_id)
      );
    })
  );
}

/** Matches `routes/proxy/model-router-cache-controls.ts` protocol fields. */
function hasProviderCacheControls(
  body: Record<string, unknown> | undefined,
): boolean {
  if (!body) return false;
  for (const field of TOP_LEVEL_CACHE_CONTROL_FIELDS) {
    if (body[field] !== undefined) return true;
  }
  if (arrayHasCacheControl(body.system)) return true;
  for (const field of ["messages", "input"] as const) {
    const entries = body[field];
    if (!Array.isArray(entries)) continue;
    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      if (nodeHasCacheControl(entry)) return true;
      if (arrayHasCacheControl(entry.content)) return true;
      if (
        entry.type === "function_call_output" &&
        arrayHasCacheControl(entry.output)
      ) {
        return true;
      }
    }
  }
  return false;
}

function nodeHasCacheControl(node: Record<string, unknown>): boolean {
  return (
    node.cache_control !== undefined ||
    node.prompt_cache_breakpoint !== undefined
  );
}

function arrayHasCacheControl(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const rawPart of value) {
    const part = asRecord(rawPart);
    if (part && nodeHasCacheControl(part)) return true;
  }
  return false;
}

function isCompactionRequest(params: {
  headers: Record<string, string | string[] | undefined>;
  bodyRecord: Record<string, unknown> | undefined;
  items: unknown;
}): boolean {
  const { headers, bodyRecord, items } = params;

  if (
    getHeaderValue(headers, OPENCODE_AGENT_HEADER) === "compaction" ||
    getHeaderValue(headers, "x-openai-subagent") === "compact" ||
    (detectGrokClientId(headers) !== undefined &&
      getHeaderValue(headers, "x-grok-conv-id")?.startsWith("turn-summary-") ===
        true) ||
    parseJsonHeader(headers, "x-codex-turn-metadata")?.request_kind ===
      "compaction"
  ) {
    return true;
  }

  if (!bodyRecord) return false;

  if (hasCodexCompactionMetadata(bodyRecord)) {
    return true;
  }

  if (
    containsCompactionInstruction(bodyRecord.system) ||
    containsCompactionInstruction(bodyRecord.instructions)
  ) {
    return true;
  }

  if (typeof items === "string") {
    return isCompactionInstructionText(items);
  }
  if (!Array.isArray(items)) return false;

  for (const item of items) {
    const record = asRecord(item);
    if (record?.role === "system" || record?.role === "developer") {
      if (containsCompactionInstruction(record.content)) return true;
    }
  }

  for (let index = items.length - 1; index >= 0; index--) {
    const record = asRecord(items[index]);
    if (record?.role !== "user") continue;
    return containsCompactionInstruction(record.content);
  }

  return false;
}

function hasCodexCompactionMetadata(body: Record<string, unknown>): boolean {
  for (const rawMetadata of [body.client_metadata, body.metadata]) {
    const metadata = asRecord(rawMetadata);
    if (!metadata) continue;
    const nestedTurn = metadata["x-codex-turn-metadata"];
    const candidates = [
      metadata,
      asRecord(metadata.turn_metadata),
      asRecord(metadata.turn),
      typeof nestedTurn === "string"
        ? parseJsonObject(nestedTurn)
        : asRecord(nestedTurn),
    ];
    if (candidates.some((turn) => turn?.request_kind === "compaction")) {
      return true;
    }
  }
  return false;
}

function containsCompactionInstruction(value: unknown): boolean {
  if (typeof value === "string") {
    return isCompactionInstructionText(value);
  }
  if (!Array.isArray(value)) return false;
  for (const block of value) {
    const text = asRecord(block)?.text;
    if (typeof text === "string" && isCompactionInstructionText(text)) {
      return true;
    }
  }
  return false;
}

function isCompactionInstructionText(value: string): boolean {
  const text = value.trimStart();
  return (
    text.startsWith(CLAUDE_COMPACTION_INSTRUCTION) ||
    text.startsWith(CLAUDE_COMPACTION_CRITICAL_INSTRUCTION) ||
    text.startsWith(KIMI_CODE_COMPACTION_INSTRUCTION)
  );
}

function isClaudeClient(
  client: string | null,
  body: Record<string, unknown> | undefined,
): boolean {
  if (isClaudeClientAgentId(client)) {
    return true;
  }
  if (!body) return false;
  const metadata = asRecord(body.metadata);
  const userId =
    typeof metadata?.user_id === "string" ? metadata.user_id : undefined;
  return (
    detectClaudeClientId({
      system: body.system,
      metadata: userId !== undefined ? { user_id: userId } : undefined,
    }) !== undefined
  );
}

function lastNonEmptySystemText(
  body: Record<string, unknown>,
  items: unknown,
): string | null {
  let latest: string | null = null;
  const recordText = (value: unknown) => {
    if (typeof value === "string") {
      if (value.trim().length > 0) latest = value;
      return;
    }
    if (!Array.isArray(value)) return;
    for (const part of value) {
      const text = textPartString(part);
      if (text !== null && text.trim().length > 0) {
        latest = text;
      }
    }
  };

  recordText(body.system);
  recordText(body.instructions);
  if (Array.isArray(items)) {
    for (const item of items) {
      const record = asRecord(item);
      if (record?.role === "system" || record?.role === "developer") {
        recordText(record.content);
      }
    }
  }
  return latest;
}

/**
 * Returns the first non-blank text block of a single-turn, text-only user
 * request (at most one non-system/developer item, role `user`, no non-text
 * content parts), or `null` otherwise.
 */
function firstTextOnlySingleTurnBlock(items: unknown): string | null {
  let content: unknown;
  if (typeof items === "string") {
    content = items;
  } else if (Array.isArray(items)) {
    let onlyUser: Record<string, unknown> | null = null;
    for (const item of items) {
      const record = asRecord(item);
      const role = record?.role;
      if (role === "system" || role === "developer") continue;
      if (onlyUser !== null || role !== "user" || !record) return null;
      onlyUser = record;
    }
    if (!onlyUser) return null;
    content = onlyUser.content;
  } else {
    return null;
  }

  if (typeof content === "string") {
    return content.trim().length > 0 ? content : null;
  }
  if (!Array.isArray(content) || content.length === 0) return null;

  let firstNonBlank: string | null = null;
  for (const part of content) {
    const text = textPartString(part);
    if (text === null) return null;
    if (firstNonBlank === null && text.trim().length > 0) {
      firstNonBlank = text;
    }
  }
  return firstNonBlank;
}

function matchesTitleUserPromptPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  for (const prefix of TITLE_USER_PROMPT_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const next = trimmed[prefix.length];
    if (
      next === undefined ||
      next === "." ||
      next === ":" ||
      next === "?" ||
      next === "!" ||
      next === "\n" ||
      next === "\r"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Conservative veto for Claude `/btw` side questions: matches whenever the last
 * user turn carries `CLAUDE_SIDE_QUESTION_PROMPT` (even alongside images), so
 * `/btw` never falls through to `claude_auxiliary_header`.
 */
function hasClaudeSideQuestion(items: unknown): boolean {
  if (typeof items === "string") {
    return items.trimStart().startsWith(CLAUDE_SIDE_QUESTION_PROMPT);
  }
  if (!Array.isArray(items)) return false;
  const last = asRecord(items.at(-1));
  if (last?.role !== "user") return false;
  if (typeof last.content === "string") {
    return last.content.trimStart().startsWith(CLAUDE_SIDE_QUESTION_PROMPT);
  }
  if (!Array.isArray(last.content)) return false;
  for (const part of last.content) {
    const text = textPartString(part);
    if (text?.trimStart().startsWith(CLAUDE_SIDE_QUESTION_PROMPT)) {
      return true;
    }
  }
  return false;
}

/**
 * Strict multipart envelope check for Claude side frames: returns the trimmed
 * final text part of the last `user` turn only when every preceding part in
 * `content` is either `type === "tool_result"` or a standalone closed
 * `<system-reminder>...</system-reminder>` text block, and the final part is a
 * text part. Any image or non-reminder text part disqualifies the match.
 */
function lastUserSideFrame(items: unknown): string | null {
  if (typeof items === "string") {
    return items.trimStart();
  }
  if (!Array.isArray(items)) return null;
  const last = asRecord(items.at(-1));
  if (last?.role !== "user") return null;

  if (typeof last.content === "string") {
    return last.content.trimStart();
  }
  if (!Array.isArray(last.content) || last.content.length === 0) return null;

  const finalText = textPartString(last.content[last.content.length - 1]);
  if (finalText === null) return null;

  for (let index = 0; index < last.content.length - 1; index++) {
    const part = last.content[index];
    const record = asRecord(part);
    if (record?.type === "tool_result") continue;
    const text = textPartString(part);
    if (text === null || !isStandaloneSystemReminder(text)) {
      return null;
    }
  }

  return finalText.trimStart();
}

function isStandaloneSystemReminder(text: string): boolean {
  let remaining = text.trim();
  if (remaining.length === 0) return false;
  while (remaining.length > 0) {
    if (!remaining.startsWith(SYSTEM_REMINDER_PREFIX)) return false;
    const closeIndex = remaining.indexOf(
      SYSTEM_REMINDER_SUFFIX,
      SYSTEM_REMINDER_PREFIX.length,
    );
    if (closeIndex === -1) return false;
    remaining = remaining
      .slice(closeIndex + SYSTEM_REMINDER_SUFFIX.length)
      .trimStart();
  }
  return true;
}

function textPartString(part: unknown): string | null {
  const record = asRecord(part);
  return (record?.type === "text" || record?.type === "input_text") &&
    typeof record.text === "string"
    ? record.text
    : null;
}

function parseJsonHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): Record<string, unknown> | undefined {
  const raw = getHeaderValue(headers, name);
  return raw ? parseJsonObject(raw) : undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
