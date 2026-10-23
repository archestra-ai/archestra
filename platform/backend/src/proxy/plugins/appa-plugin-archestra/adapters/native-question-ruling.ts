import type {
  NativeQuestionNoAnswer,
  NativeQuestionReading,
  NativeQuestionResult,
} from "../types";

/**
 * Reads Approve or Deny from the result of a client's own question tool.
 * `question` is the question text the platform asked, as the client showed it.
 */
export function structuredQuestionRuling(
  result: NativeQuestionResult,
  question: string,
): NativeQuestionReading {
  const reading = labeledQuestionRuling(result, question, RULING_LABELS);
  if (typeof reading === "object") {
    return reading.label === "Approve" ? "approve" : "deny";
  }
  return reading;
}

export function openCodeQuestionRuling(
  result: NativeQuestionResult,
  question: string,
): NativeQuestionReading {
  if (result.isError) return "unavailable";
  const reading = textQuestionSelection(
    result.content,
    question,
    RULING_LABELS,
  );
  if (typeof reading === "object") {
    return reading.label === "Approve" ? "approve" : "deny";
  }
  return reading;
}

/**
 * Reads which of the given option labels the answer selects, for a question
 * the platform wrote. Returns the selected label, a known terminal no-answer,
 * or "unrecognized" for a wording the adapter does not know. An unrecognized
 * answer is never read as a choice.
 */
export function labeledQuestionRuling(
  result: NativeQuestionResult,
  question: string,
  labels: readonly string[],
): { label: string } | NativeQuestionNoAnswer | "unrecognized" {
  if (result.isError) return "unavailable";
  try {
    const parsed = JSON.parse(result.content) as { answers?: unknown };
    if (typeof parsed === "string")
      return textQuestionSelection(parsed, question, labels);
    const structured = selectionFromValues(
      stringValues(parsed.answers),
      labels,
    );
    return (
      structured ?? textQuestionSelection(result.content, question, labels)
    );
  } catch {
    return textQuestionSelection(result.content, question, labels);
  }
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
 * answer is a no-answer. Any other text is "unrecognized", never a guess.
 */
function textQuestionSelection(
  content: string,
  question: string,
  labels: readonly string[],
): { label: string } | NativeQuestionNoAnswer | "unrecognized" {
  for (const opening of ANSWER_OPENINGS) {
    const asked = `${opening}"${question}"="`;
    if (!content.startsWith(asked)) continue;
    const answer = content.slice(asked.length);
    // Longest first: a label that prefixes another cannot shadow it.
    for (const label of [...labels].sort((a, b) => b.length - a.length)) {
      if (
        SELECTED_OPTION_ENDINGS.some((ending) =>
          answer.startsWith(`${label}"${ending}`),
        )
      )
        return { label };
    }
  }
  const trimmed = content.trim();
  return (
    NO_ANSWER.get(trimmed) ??
    (TIMED_OUT_ANSWER.test(trimmed) ? "unanswered" : "unrecognized")
  );
}

function selectionFromValues(
  values: readonly string[],
  labels: readonly string[],
): { label: string } | undefined {
  const selected = values.filter((value) => labels.includes(value));
  return selected.length === 1 ? { label: selected[0] } : undefined;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringValues);
  return [];
}

const RULING_LABELS = ["Approve", "Deny"];

// The openings of a submitted answer. Claude Code writes the first, OpenCode
// and earlier Claude Code versions the second.
const ANSWER_OPENINGS = [
  "Your questions have been answered: ",
  "User has answered your questions: ",
];

// The whole answer when the user answered nothing: Claude Code, and earlier
// Claude Code versions. These close the review; they are not a Deny.
const NO_ANSWER = new Map<string, "unanswered" | "declined">([
  ["The user did not answer the questions.", "unanswered"],
  ["User has declined to answer your questions.", "declined"],
  ["User dismissed the question.", "declined"],
]);

// Claude Code's answer when its question auto-continue timeout
// (askUserQuestionTimeout) ends a question nobody touched. It counts the wait in
// seconds, so a "10m" timeout reads "No response after 600s".
const TIMED_OUT_ANSWER =
  /^No response after \d+s \u2014 the user may be away from keyboard\./;

// What follows a selected option: the closing sentence, or the selected
// option's preview (Claude Code).
const SELECTED_OPTION_ENDINGS = [
  ". You can now continue",
  " selected preview:\n",
];
