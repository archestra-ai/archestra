import type { AskUserArguments, NativeQuestionResult } from "../types";
import { questionHeader } from "../utils";
import { labeledQuestionRuling } from "./native-question-ruling";

const OPTIONS_PER_GROUP = 3;
const MAX_CHOICES = 12;

export function claudeOversizedQuestion(
  input: unknown,
): AskUserArguments | undefined {
  if (!input || typeof input !== "object") return undefined;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length !== 1) return undefined;
  const question = questions[0];
  if (
    !question ||
    typeof question.question !== "string" ||
    !Array.isArray(question.options) ||
    question.options.length <= 4 ||
    question.options.length > MAX_CHOICES ||
    !question.options.every(
      (option: unknown) =>
        option &&
        typeof option === "object" &&
        typeof (option as { label?: unknown }).label === "string" &&
        ((option as { description?: unknown }).description === undefined ||
          typeof (option as { description?: unknown }).description ===
            "string"),
    )
  )
    return undefined;
  return {
    question: question.question,
    header: question.header,
    options: question.options.map(
      (option: { label: string; description?: string }) => ({
        label: option.label,
        description: option.description,
      }),
    ),
    allowMultiple: question.multiSelect === true,
  };
}

/**
 * Claude permits four questions with four options each. A skip option in each
 * group lets a person answer one original question across all four cards.
 */
export function claudeDesktopQuestion(args: AskUserArguments) {
  if (args.options.length > MAX_CHOICES)
    throw new Error("Claude Desktop supports at most twelve gateway choices.");
  const grouped = args.options.length > 4;
  const count = grouped
    ? Math.ceil(args.options.length / OPTIONS_PER_GROUP)
    : 1;
  const size = grouped ? OPTIONS_PER_GROUP : 4;
  const labels = new Set(args.options.map((option) => option.label));
  return {
    questions: Array.from({ length: count }, (_, index) => {
      let skip = `No choice in group ${index + 1}`;
      while (labels.has(skip)) skip += ".";
      const options = args.options
        .slice(index * size, (index + 1) * size)
        .map(({ label, description }) => ({
          label,
          description: description ?? label,
        }));
      if (grouped) {
        options.push({
          label: skip,
          description: "Choose this if your answer is in another group.",
        });
      }
      return {
        question: grouped
          ? `${args.question}\n\nGroup ${index + 1} of ${count}. ${
              args.allowMultiple
                ? "Select your choices across the groups."
                : "Select exactly one choice across all groups."
            } Select "${skip}" if you want no choice from this group.`
          : args.question,
        header: grouped
          ? `${questionHeader(args.header, 8)} ${index + 1}/${count}`
          : questionHeader(args.header, 12),
        options,
        multiSelect: args.allowMultiple === true,
      };
    }),
  };
}

/** Ordinary answer data is never used to record a guardrail ruling. */
export function claudeDesktopGroupedAnswer(
  result: NativeQuestionResult,
  asked: AskUserArguments,
): string {
  const { questions } = claudeDesktopQuestion(asked);
  const terminal = labeledQuestionRuling(result, questions[0].question, []);
  if (
    terminal === "declined" ||
    terminal === "cancelled" ||
    terminal === "unanswered" ||
    terminal === "unavailable"
  ) {
    return JSON.stringify({
      action: terminal === "declined" ? "decline" : "cancel",
      selected: [],
      message: "No answer was submitted. Wait for a new user message.",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    parsed = result.content;
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const answers = record?.answers;
  let values: unknown[] | undefined;
  if (answers && typeof answers === "object" && !Array.isArray(answers)) {
    const entries = answers as Record<string, unknown>;
    if (
      questions.every(
        (question) =>
          Object.hasOwn(entries, question.question) ||
          Object.hasOwn(entries, question.header),
      )
    ) {
      values = questions.map((question) =>
        Object.hasOwn(entries, question.question)
          ? entries[question.question]
          : entries[question.header],
      );
    }
  } else if (typeof parsed === "string") {
    values = textAnswers(parsed, questions);
  }
  if (!values) return invalidAnswer("The native answer could not be read.");
  const selected: string[] = [];
  const typed: string[] = [];
  for (const [index, value] of values.entries()) {
    const options = questions[index].options;
    const original = asked.options
      .slice(index * OPTIONS_PER_GROUP, (index + 1) * OPTIONS_PER_GROUP)
      .map((option) => option.label);
    const rawValues = Array.isArray(value) ? value : [value];
    if (!rawValues.every((item) => typeof item === "string"))
      return invalidAnswer("The native answer contained an invalid selection.");
    for (const raw of rawValues as string[]) {
      // A structured array is unambiguous. A text multi-selection can contain
      // commas in a label, so accept it only if exactly one subset matches.
      const matches =
        Array.isArray(value) || !asked.allowMultiple
          ? options
              .filter((option) => option.label === raw)
              .map((option) => [option.label])
          : matchingSelections(
              raw,
              options.map((option) => option.label),
            );
      if (matches.length > 1)
        return invalidAnswer("The native answer was ambiguous.");
      const labels = matches[0];
      if (labels) {
        selected.push(...labels.filter((label) => original.includes(label)));
      } else {
        // Skip/dismiss sentinels are not typed answers.
        if (
          /^\[(?:No preference|User )/.test(raw) ||
          raw.startsWith("The user did not answer this question.")
        )
          return invalidAnswer("The user did not answer every group.");
        if (raw.trim()) typed.push(raw.trim());
      }
    }
  }
  const unique = asked.options
    .map((option) => option.label)
    .filter((label) => selected.includes(label));
  if (!asked.allowMultiple && unique.length > 1) {
    return JSON.stringify({
      error: "multiple_choices",
      selected: [],
      candidates: unique,
      message:
        "The user selected choices in several groups. Ask which single choice they intend before proceeding.",
    });
  }
  if (unique.length === 0 && typed.length === 0)
    return invalidAnswer("The user selected no choice.");
  return JSON.stringify({
    action: "accept",
    selected: unique,
    ...(typed.length > 0 ? { text: typed.join("\n") } : {}),
  });
}

function invalidAnswer(message: string): string {
  return JSON.stringify({
    error: "unconfirmed_answer",
    selected: [],
    message: `${message} Do not assume a choice or repeat the question automatically. Wait for the user.`,
  });
}

function matchingSelections(raw: string, labels: string[]): string[][] {
  return labels.flatMap((label) => {
    if (raw === label) return [[label]];
    const prefix = `${label}, `;
    if (!raw.startsWith(prefix)) return [];
    return matchingSelections(
      raw.slice(prefix.length),
      labels.filter((other) => other !== label),
    ).map((rest) => [label, ...rest]);
  });
}

function textAnswers(
  content: string,
  questions: ReturnType<typeof claudeDesktopQuestion>["questions"],
): string[] | undefined {
  const opening = [
    "Your questions have been answered: ",
    "User has answered your questions: ",
    "The user answered: ",
  ].find((prefix) => content.startsWith(prefix));
  if (!opening) return undefined;
  let remaining = content.slice(opening.length);
  const values: string[] = [];
  for (const [index, question] of questions.entries()) {
    const marker = `"${question.question}"="`;
    if (!remaining.startsWith(marker)) return undefined;
    remaining = remaining.slice(marker.length);
    const next = questions[index + 1];
    if (next) {
      const boundary = remaining.indexOf(`", "${next.question}"="`);
      if (boundary < 0) return undefined;
      values.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary + 3);
    } else {
      const boundary = remaining.endsWith('"')
        ? remaining.length - 1
        : Math.max(
            remaining.lastIndexOf('". You can now continue'),
            remaining.lastIndexOf('". Read the answers carefully'),
          );
      if (boundary < 0) return undefined;
      values.push(remaining.slice(0, boundary));
    }
  }
  return values;
}
