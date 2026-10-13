import type {
  NativeQuestionReading,
  NativeQuestionResult,
  NativeQuestionRuling,
} from "../types";

/**
 * Reads Approve or Deny from the result of a client's own question tool.
 * `question` is the question text the platform asked, as the client showed it.
 */
export function structuredQuestionRuling(
  result: NativeQuestionResult,
  question: string,
): NativeQuestionReading {
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
): NativeQuestionReading {
  if (result.isError) return "none";
  return textQuestionRuling(result.content, question);
}

/**
 * Claude Code and OpenCode answer in one text: an opening sentence, then
 * `"<question>"="<answer>"`. The question, and the option preview Claude Code
 * adds after the answer, can repeat text the agent wrote in the reviewed call.
 * So the answer is read in one place only: directly after the question the
 * platform asked.
 *
 * Only the client's wording tells a submitted answer from one that merely
 * repeats a selection: Claude Code also writes `"<question>"="Approve"` when
 * the user went idle before submitting, asked a follow-up, or added a note.
 * So only the wordings below count. A known text that says the user gave no
 * answer is "none". Any other text is "unrecognized", never a guess.
 */
function textQuestionRuling(
  content: string,
  question: string,
): NativeQuestionReading {
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
  return NO_ANSWER_TEXTS.includes(content.trim()) ? "none" : "unrecognized";
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

// The openings of a submitted answer. Claude Code writes the first, OpenCode
// and earlier Claude Code versions the second.
const ANSWER_OPENINGS = [
  "Your questions have been answered: ",
  "User has answered your questions: ",
];

// The whole answer when the user answered nothing: Claude Code, and earlier
// Claude Code versions. These can only withhold an approval.
const NO_ANSWER_TEXTS = [
  "The user did not answer the questions.",
  "User has declined to answer your questions.",
];

// What follows a selected option: the closing sentence, or the selected
// option's preview (Claude Code).
const SELECTED_OPTION_ENDINGS = [
  ". You can now continue",
  " selected preview:\n",
];
