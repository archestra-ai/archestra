import type { NativeQuestionResult, NativeQuestionRuling } from "../types";

export function structuredQuestionRuling(
  result: NativeQuestionResult,
): NativeQuestionRuling {
  if (result.isError) return "none";
  try {
    const parsed = JSON.parse(result.content) as { answers?: unknown };
    if (Array.isArray(parsed)) {
      if (
        parsed.length !== 1 ||
        parsed[0]?.type !== "text" ||
        typeof parsed[0]?.text !== "string"
      )
        return "none";
      const text = parsed[0].text;
      try {
        const value = JSON.parse(text) as { answers?: unknown };
        return rulingFromValues(answerValues(value?.answers));
      } catch {
        return textQuestionRuling(text);
      }
    }
    if (typeof parsed === "string") return textQuestionRuling(parsed);
    return rulingFromValues(answerValues(parsed?.answers));
  } catch {
    return textQuestionRuling(result.content);
  }
}

export function openCodeQuestionRuling(
  result: NativeQuestionResult,
): NativeQuestionRuling {
  if (result.isError) return "none";
  return textQuestionRuling(result.content);
}

function textQuestionRuling(content: string): NativeQuestionRuling {
  const claude = [
    ...content.matchAll(/="([^"\r\n]*)"\.\s*You can now continue\b/g),
  ].at(-1);
  if (claude?.[1]) return rulingFromValues([claude[1]]);
  const openCode = content.trimEnd().match(/="([^"\r\n]*)"$/);
  return rulingFromValues(openCode?.[1] ? [openCode[1]] : []);
}

function rulingFromValues(values: readonly unknown[]): NativeQuestionRuling {
  if (values.length !== 1) return "none";
  if (values[0] === "Approve") return "approve";
  return values[0] === "Deny" ? "deny" : "none";
}

function answerValues(value: unknown): unknown[] {
  if (Array.isArray(value))
    return value.length ? value.flatMap(answerValues) : [undefined];
  if (value && typeof value === "object") {
    const values = Object.values(value);
    return values.length ? values.flatMap(answerValues) : [undefined];
  }
  return [value];
}
