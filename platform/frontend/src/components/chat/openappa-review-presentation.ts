/**
 * Turns an OpenAPPA review payload into the same structured call Chat shows
 * on a tool card: a tool name plus arguments with nested JSON strings revived
 * so `todos: "[{\\"id\\":1}]"` renders as an array, not an escaped blob.
 */

export type ReviewPresentation = {
  intro: string;
  tool?: string;
  arguments?: unknown;
  rest: string;
};

export function parseReviewPresentation({
  message,
  reviewedTool,
  reviewedArguments,
}: {
  message: string;
  reviewedTool?: string;
  reviewedArguments?: string;
}): ReviewPresentation {
  const extracted = extractFromMessage(message);
  const tool = reviewedTool?.trim() || extracted.tool;
  const argumentsJson = reviewedArguments ?? extracted.argumentsJson;
  return {
    intro: extracted.intro,
    ...(tool ? { tool } : {}),
    ...(argumentsJson ? { arguments: parseJsonArguments(argumentsJson) } : {}),
    rest: extracted.rest,
  };
}

/** Parse JSON text and revive string values that are themselves JSON. */
export function parseJsonArguments(raw: string): unknown {
  try {
    return reviveJsonStrings(JSON.parse(raw));
  } catch {
    return raw;
  }
}

export function reviveJsonStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return reviveJsonStrings(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(reviveJsonStrings);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        reviveJsonStrings(nested),
      ]),
    );
  }
  return value;
}

function extractFromMessage(message: string): {
  intro: string;
  tool?: string;
  argumentsJson?: string;
  rest: string;
} {
  const toolMatch = /^Tool:\s+(\S+)\s*$/m.exec(message);
  const argumentsHeader = /^Arguments:\s*$/m.exec(message);
  const coverageHeader = /^What this ruling would cover:\s*$/m.exec(message);

  const toolLineStart = toolMatch?.index;
  const intro = (
    toolLineStart !== undefined
      ? message.slice(0, toolLineStart)
      : argumentsHeader
        ? message.slice(0, argumentsHeader.index)
        : coverageHeader
          ? message.slice(0, coverageHeader.index)
          : message
  ).trim();

  const rest = coverageHeader ? message.slice(coverageHeader.index).trim() : "";

  let argumentsJson: string | undefined;
  if (argumentsHeader) {
    const afterHeader = message.slice(
      argumentsHeader.index + argumentsHeader[0].length,
    );
    const jsonEnd = coverageHeader
      ? coverageHeader.index -
        (argumentsHeader.index + argumentsHeader[0].length)
      : afterHeader.length;
    const jsonSlice = afterHeader.slice(0, jsonEnd).trim();
    if (jsonSlice.startsWith("{") || jsonSlice.startsWith("[")) {
      argumentsJson = jsonSlice;
    }
  }

  return {
    intro,
    ...(toolMatch ? { tool: toolMatch[1] } : {}),
    ...(argumentsJson ? { argumentsJson } : {}),
    rest,
  };
}
