import type { NativeQuestionResult, NativeQuestionRuling } from "../types";

/**
 * Reads Approve or Deny from the result of a client's own question tool.
 * `question` is the question text the platform asked, as the client showed it.
 */
export function structuredQuestionRuling(
  result: NativeQuestionResult,
  question: string,
): NativeQuestionRuling {
  if (result.isError) return "none";
  try {
    const parsed = JSON.parse(result.content) as { answers?: unknown };
    if (typeof parsed === "string") return textQuestionRuling(parsed, question);
    const structured = rulingFromValues(stringValues(parsed.answers));
    return structured !== "none"
      ? structured
      : textQuestionRuling(result.content, question);
  } catch {
    return textQuestionRuling(result.content, question);
  }
}

export function openCodeQuestionRuling(
  result: NativeQuestionResult,
  question: string,
): NativeQuestionRuling {
  if (result.isError) return "none";
  return textQuestionRuling(result.content, question);
}

/**
 * Claude Code and OpenCode answer in one text: a fixed opening, then
 * `"<question>"="<answer>"`. The question, and the option preview Claude Code
 * adds after the answer, can repeat text the agent wrote in the reviewed call.
 * So the answer is read in one place only: directly after the question the
 * platform asked. Any other text is not a ruling.
 */
function textQuestionRuling(
  content: string,
  question: string,
): NativeQuestionRuling {
  for (const opening of ANSWER_OPENINGS) {
    const asked = `${opening}"${question}"="`;
    if (!content.startsWith(asked)) continue;
    const answer = content.slice(asked.length);
    for (const label of ["Approve", "Deny"]) {
      if (
        SELECTED_OPTION_ENDINGS.some((ending) =>
          answer.startsWith(`${label}"${ending}`),
        )
      )
        return rulingFromValues([label]);
    }
  }
  return "none";
}

function rulingFromValues(values: readonly string[]): NativeQuestionRuling {
  const selected = values.filter(
    (value) => value === "Approve" || value === "Deny",
  );
  if (selected.length !== 1) return "none";
  return selected[0] === "Approve" ? "approve" : "deny";
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringValues);
  return [];
}

// Claude Code opens with the first text. OpenCode and earlier Claude Code
// versions open with the second. A timeout, a follow-up request, or an answer
// with the user's own notes opens with other text and is not a ruling.
const ANSWER_OPENINGS = [
  "Your questions have been answered: ",
  "User has answered your questions: ",
];

// What follows a selected option: the closing sentence, or the selected
// option's preview (Claude Code).
const SELECTED_OPTION_ENDINGS = [
  ". You can now continue",
  " selected preview:\n",
];
