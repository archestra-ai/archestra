import type { IncomingHttpHeaders } from "node:http";
import type { CommonToolResult } from "@/types/common-llm-format";
import { asRecord } from "@/utils/as-record";
import { readHeader } from "../utils";

/**
 * A request Claude Code sends beside its agent loop in the same session. Its
 * reply is never the turn's or the subagent's end.
 */
export type ClaudeSideRequest =
  | "progress_label"
  | "side_question"
  | "away_summary"
  | "auxiliary";

/** What /btw sends in place of a result for a call still running elsewhere. */
const CLAUDE_PENDING_RESULT =
  "[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]";

const PROGRESS_LABEL_PROMPTS = [
  "Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.",
  "Describe the agent's most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch.",
].flatMap((prompt) => [`${prompt}\nGood: `, `${prompt}\n\nGood: `]);
const NOTES_LABEL_SYSTEM_PROMPT =
  "You write a 3-5 word progress label for a background agent, from short notes about what it is doing.";
const SIDE_QUESTION_PROMPT =
  "<system-reminder>This is a side question from the user. You must answer this question directly in a single response.";
const AWAY_SUMMARY_PROMPT =
  "The user stepped away and is coming back. Recap in under 40 words";

export function claudeSideRequest(params: {
  body: unknown;
  headers: IncomingHttpHeaders;
  /** The subagent's admitted opening task, which is never a side request. */
  isOpeningTask: (prompt: string) => boolean;
}): ClaudeSideRequest | undefined {
  const body = asRecord(params.body);
  const last = Array.isArray(body?.messages)
    ? asRecord(body.messages.at(-1))
    : undefined;
  const texts = last?.role === "user" ? textBlocks(last.content) : [];
  // Claude Code appends its frame as the last text, after any tool results.
  const frame = texts.at(-1);
  if (
    frame !== undefined &&
    (params.isOpeningTask(texts.join("\n")) || params.isOpeningTask(frame))
  )
    return undefined;
  const tools = body?.tools;
  if (
    (!Array.isArray(tools) || tools.length === 0) &&
    textBlocks(body?.system).some((text) =>
      text.startsWith(NOTES_LABEL_SYSTEM_PROMPT),
    )
  )
    return "progress_label";
  if (frame !== undefined) {
    if (PROGRESS_LABEL_PROMPTS.some((prompt) => frame.startsWith(prompt)))
      return "progress_label";
    if (frame.startsWith(SIDE_QUESTION_PROMPT)) return "side_question";
    if (frame.startsWith(AWAY_SUMMARY_PROMPT)) return "away_summary";
  }
  switch (readHeader(params.headers, "x-claude-code-request-class")) {
    case "auxiliary":
    case "side_reply":
      return "auxiliary";
    default:
      return undefined;
  }
}

/** Claude Code's stand-in for a running call's result: not its outcome. */
export function isClaudePendingResult(
  result: Pick<CommonToolResult, "content" | "isError">,
): boolean {
  if (result.isError) return false;
  const blocks = Array.isArray(result.content) ? result.content : undefined;
  const block = blocks?.length === 1 ? asRecord(blocks[0]) : undefined;
  return (
    result.content === CLAUDE_PENDING_RESULT ||
    (block?.type === "text" && block.text === CLAUDE_PENDING_RESULT)
  );
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
}
