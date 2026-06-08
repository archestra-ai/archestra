import { createHash } from "node:crypto";
import type { ChatMessage, ChatMessagePart } from "@/types";

/**
 * Converts a conversation (our AI-SDK `ChatMessage[]`) into a Claude-Code-format
 * `.jsonl` transcript — one JSON object per line — so hook scripts can read it
 * via `transcript_path` exactly the way Claude Code exposes it.
 *
 * Fidelity: the per-line envelope matches Claude Code's. Fields that have a real
 * Archestra source map directly; the rest are SYNTHESIZED and marked `// SYNTH`
 * below (we have no shell cwd, Claude Code version, git branch, provider request
 * id, token usage, etc.). Tool calls are split the way Claude Code stores them:
 * the call is a `tool_use` block on the assistant line, and its result is a
 * SEPARATE `type:"user"` line carrying a `tool_result` block + `toolUseResult`.
 */
export interface TranscriptOptions {
  /** Real: the conversation id (Claude's `sessionId`). */
  sessionId: string;
  /** SYNTH: the sandbox home stood in for a shell cwd. */
  cwd: string;
  /** Real: the conversation's model id, stamped on assistant lines. */
  model: string;
  /** SYNTH: stand-in for Claude Code's `version`. */
  version: string;
  /** SYNTH: per-line timestamps aren't tracked; one stamp (fire time) is reused. */
  timestamp: string;
}

export function messagesToClaudeTranscript(
  messages: ChatMessage[],
  opts: TranscriptOptions,
): string {
  const lines: ClaudeTranscriptLine[] = [];
  // parentUuid threads every emitted line (including split tool_result lines)
  // into one linear chain, matching Claude Code's parent links.
  let prevUuid: string | null = null;

  const push = (line: Omit<ClaudeTranscriptLine, "parentUuid">): void => {
    lines.push({ parentUuid: prevUuid, ...line });
    prevUuid = line.uuid;
  };

  const envelope = (uuid: string, type: "user" | "assistant") => ({
    isSidechain: false, // SYNTH: no sub-agent sidechains in this model
    userType: "external" as const, // SYNTH: constant Claude Code emits
    cwd: opts.cwd, // SYNTH: sandbox home, not a real shell cwd
    sessionId: opts.sessionId, // real
    version: opts.version, // SYNTH: no Claude Code version to report
    gitBranch: "", // SYNTH: not tracked
    type,
    uuid,
    timestamp: opts.timestamp, // SYNTH: single stamp reused for every line
  });

  messages.forEach((message, index) => {
    const seed = message.id ?? `msg-${index}`;

    if (message.role === "user") {
      const content = userContentBlocks(message.parts ?? []);
      if (content.length === 0) {
        return;
      }
      push({
        ...envelope(lineUuid(seed), "user"),
        message: { role: "user", content },
      });
      return;
    }

    if (message.role === "assistant") {
      const { blocks, toolParts } = assistantContent(message.parts ?? []);
      if (blocks.length > 0) {
        push({
          ...envelope(lineUuid(seed), "assistant"),
          message: {
            id: seed, // real: the assistant message id
            type: "message",
            role: "assistant",
            model: opts.model, // real
            content: blocks,
            stop_reason: null, // SYNTH: not tracked per message
            stop_sequence: null, // SYNTH
            usage: { input_tokens: 0, output_tokens: 0 }, // SYNTH: usage not threaded here
          },
          requestId: lineUuid(`${seed}:req`), // SYNTH: no provider request id
        });
      }
      // Each tool call's result becomes its own user-type line, as Claude does.
      for (const tp of toolParts) {
        push({
          ...envelope(lineUuid(`${seed}:result:${tp.toolCallId}`), "user"),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: tp.toolCallId,
                content: toolResultText(tp.output),
                is_error: tp.isError,
              },
            ],
          },
          toolUseResult: tp.output ?? null, // SYNTH: structured echo of the result
        });
      }
    }
    // system / tool roles are not represented (tool results live on assistant
    // parts; system prompts aren't part of the user-visible transcript).
  });

  return lines.length === 0
    ? ""
    : `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

// === internal ===

interface ClaudeTextBlock {
  type: "text";
  text: string;
}
interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
}
interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}
type ClaudeAssistantBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock;

interface ClaudeTranscriptLine {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: "external";
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  type: "user" | "assistant";
  message:
    | { role: "user"; content: ClaudeTextBlock[] | ClaudeToolResultBlock[] }
    | {
        id: string;
        type: "message";
        role: "assistant";
        model: string;
        content: ClaudeAssistantBlock[];
        stop_reason: null;
        stop_sequence: null;
        usage: { input_tokens: number; output_tokens: number };
      };
  uuid: string;
  timestamp: string;
  requestId?: string;
  toolUseResult?: unknown;
}

interface ToolPart {
  toolCallId: string;
  output: unknown;
  isError: boolean;
}

function isToolPart(part: ChatMessagePart): boolean {
  return (
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

function toolNameOf(part: ChatMessagePart): string {
  if (typeof part.toolName === "string") {
    return part.toolName;
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length);
  }
  return "unknown";
}

function userContentBlocks(parts: ChatMessagePart[]): ClaudeTextBlock[] {
  const blocks: ClaudeTextBlock[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return blocks;
}

function assistantContent(parts: ChatMessagePart[]): {
  blocks: ClaudeAssistantBlock[];
  toolParts: ToolPart[];
} {
  const blocks: ClaudeAssistantBlock[] = [];
  const toolParts: ToolPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (
      part.type === "reasoning" &&
      typeof part.text === "string" &&
      part.text
    ) {
      blocks.push({ type: "thinking", thinking: part.text });
    } else if (isToolPart(part) && typeof part.toolCallId === "string") {
      blocks.push({
        type: "tool_use",
        id: part.toolCallId,
        name: toolNameOf(part),
        input: (part as { input?: unknown }).input ?? {},
      });
      toolParts.push({
        toolCallId: part.toolCallId,
        output: part.output ?? part.result,
        isError: part.state === "output-error",
      });
    }
    // data-* (incl. data-hook-run), step-start, file, source → not model content
  }
  return { blocks, toolParts };
}

/** Claude's `tool_result.content` is a string; structured output is JSON-encoded. */
function toolResultText(output: unknown): string {
  if (output === undefined || output === null) {
    return "";
  }
  if (typeof output === "string") {
    return output;
  }
  if (
    typeof output === "object" &&
    "content" in output &&
    typeof (output as { content?: unknown }).content === "string"
  ) {
    return (output as { content: string }).content;
  }
  return JSON.stringify(output);
}

/**
 * Deterministic UUID (v5-style) from a seed: sha256 → first 16 bytes → stamp
 * version + variant. Stable per seed so the transcript — and its parentUuid
 * chain — is reproducible across rebuilds (and unit tests) instead of random.
 */
function lineUuid(seed: string): string {
  const b = createHash("sha256").update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
