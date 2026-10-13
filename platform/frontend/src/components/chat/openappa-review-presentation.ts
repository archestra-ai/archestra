/**
 * Formats an OpenAPPA review payload for tool card display.
 * Extracts the tool name and parses JSON strings into structured arguments.
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

export type ReviewDecision = "approve" | "deny";

export const REVIEW_STATUS_DESCRIPTION =
  "Review this tool call before it can continue.";

export type ReviewCardView = {
  /** Present when the review names a tool or carries arguments. */
  toolCard?: { title?: string; input?: unknown };
  /** Status-row text: the standard prompt, or the review text when no tool parsed. */
  description: string;
};

/**
 * What the approval card shows. A review with a parseable tool gets the tool
 * card with the standard prompt; one without falls back to its own text.
 */
export function getReviewCardView({
  message,
  reviewedTool,
  reviewedArguments,
}: {
  message: string;
  reviewedTool?: string;
  reviewedArguments?: string;
}): ReviewCardView {
  const presentation = parseReviewPresentation({
    message,
    ...(reviewedTool ? { reviewedTool } : {}),
    ...(reviewedArguments ? { reviewedArguments } : {}),
  });
  if (presentation.tool || presentation.arguments !== undefined) {
    return {
      toolCard: {
        ...(presentation.tool ? { title: presentation.tool } : {}),
        ...(presentation.arguments !== undefined
          ? { input: presentation.arguments }
          : {}),
      },
      description: REVIEW_STATUS_DESCRIPTION,
    };
  }
  return { description: message.trim() || REVIEW_STATUS_DESCRIPTION };
}

/**
 * The schema field a review decision answers: the one whose enum offers
 * approve or deny (OpenAPPA sends `{action: enum ["approve","deny"]}`).
 */
export function getReviewDecisionField(requestedSchema: unknown): string {
  const properties =
    isRecord(requestedSchema) && isRecord(requestedSchema.properties)
      ? requestedSchema.properties
      : {};
  return (
    Object.entries(properties).find(
      ([, schema]) =>
        isRecord(schema) &&
        Array.isArray(schema.enum) &&
        (schema.enum.includes("approve") || schema.enum.includes("deny")),
    )?.[0] ?? "action"
  );
}

/** The form answer a review decision submits, e.g. `{action: "approve"}`. */
export function getReviewDecisionContent({
  requestedSchema,
  decision,
}: {
  requestedSchema: unknown;
  decision: ReviewDecision;
}): Record<string, ReviewDecision> {
  return { [getReviewDecisionField(requestedSchema)]: decision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
