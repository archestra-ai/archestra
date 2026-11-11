/**
 * Formats an OpenAPPA review payload for tool card display, from the
 * structured fields the platform sends with it.
 */

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

export type ReviewDecision = "approve" | "deny";

export const REVIEW_STATUS_DESCRIPTION =
  "Review this tool call before it can continue.";

export type ReviewCardView = {
  /** Present when the review names a tool or carries arguments. */
  toolCard?: { title?: string; input?: unknown };
  /** Visible review text, including any additional approval scope. */
  description: string;
};

/**
 * What the approval card shows. A review with a structured tool gets the tool
 * card and the standard prompt, followed by what approving also accepts, or
 * by the review text when that is unknown. One without a tool falls back to
 * its own message.
 */
export function getReviewCardView({
  message,
  reviewedTool,
  reviewedArguments,
  reviewedCoverage,
  reviewedText,
}: {
  message: string;
  reviewedTool?: string;
  reviewedArguments?: string;
  reviewedCoverage?: string[];
  reviewedText?: string;
}): ReviewCardView {
  const tool = reviewedTool?.trim();
  const input = reviewedArguments
    ? parseJsonArguments(reviewedArguments)
    : undefined;
  if (!tool && input === undefined) {
    return { description: message.trim() || REVIEW_STATUS_DESCRIPTION };
  }
  // No coverage and no text: a request from before the platform sent either,
  // whose message is the review itself.
  const details = reviewedCoverage
    ? reviewedCoverage.length
      ? [
          "Approving also accepts:",
          ...reviewedCoverage.map((line) => `  - ${line}`),
        ].join("\n")
      : undefined
    : (reviewedText ?? message).trim();
  return {
    toolCard: {
      ...(tool ? { title: tool } : {}),
      ...(input !== undefined ? { input } : {}),
    },
    description: details
      ? [REVIEW_STATUS_DESCRIPTION, details].join("\n\n")
      : REVIEW_STATUS_DESCRIPTION,
  };
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
