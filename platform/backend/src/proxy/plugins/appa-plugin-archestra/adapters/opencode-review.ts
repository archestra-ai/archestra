// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { AskUserArguments } from "../types";

/**
 * Native question text is also the fallback UI. Length framing keeps strings
 * inside a reviewed command from impersonating the full-review separator.
 * The connection plugin renders this same text in a compact, paged dialog.
 */
export function openCodeReviewQuestion(
  card: AskUserArguments,
  reviewText?: string,
): string {
  const title = card.shortQuestion ?? card.question;
  const preview =
    card.options.find((option) => option.label === "Allow")?.preview ??
    card.callPreview;
  if (!preview) return reviewText ? `${title}\n\n${reviewText}` : title;
  return `${title}\n\nCall preview (${preview.length} characters):\n${preview}${
    reviewText ? `\n\nFull review:\n${reviewText}` : ""
  }`;
}
