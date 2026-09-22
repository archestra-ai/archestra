import type { NativeQuestionResult, NativeQuestionRuling } from "../types";

export function structuredQuestionRuling(
  result: NativeQuestionResult,
): NativeQuestionRuling {
  if (result.isError) return "none";
  try {
    const parsed = JSON.parse(result.content) as { answers?: unknown };
    if (typeof parsed === "string") return textQuestionRuling(parsed);
    const structured = rulingFromValues(stringValues(parsed.answers));
    return structured !== "none"
      ? structured
      : textQuestionRuling(result.content);
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
    ...content.matchAll(/="(Approve|Deny)"\.\s*You can now continue\b/g),
  ].at(-1);
  if (claude?.[1]) return rulingFromValues([claude[1]]);
  const openCode = content.trimEnd().match(/="(Approve|Deny)"$/);
  return rulingFromValues(openCode?.[1] ? [openCode[1]] : []);
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
