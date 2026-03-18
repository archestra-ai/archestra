/**
 * Compute how many characters before and after the cursor should be replaced
 * when inserting a Handlebars expression like `{{currentDate}}`.
 *
 * This ensures that already-typed `{` characters before the cursor and any
 * auto-closed `}` characters after the cursor are consumed by the replacement,
 * preventing duplicates like `{{{currentDate}}}`.
 */
export function computeHandlebarsReplaceOffsets(
  textBeforeCursor: string,
  textAfterCursor: string,
): { startOffset: number; endOffset: number } {
  const startOffset = textBeforeCursor.match(/\{+$/)?.[0]?.length ?? 0;
  const endOffset = textAfterCursor.match(/^\}+/)?.[0]?.length ?? 0;
  return { startOffset, endOffset };
}

export function shouldShowHandlebarsCompletions(
  textBeforeCursor: string,
): boolean {
  return /\{\{\{?\s*[\w.-]*$/.test(textBeforeCursor);
}
