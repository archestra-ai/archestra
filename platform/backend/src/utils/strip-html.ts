/**
 * General-purpose HTML-to-plain-text conversion.
 *
 * Handles block-level elements, nested tags, and common HTML entities.
 * For email-specific HTML (blockquotes, horizontal rules), use {@link stripHtmlEmail}.
 */
export function stripHtmlTags(html: string): string {
  let text = html;
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = stripTagsIteratively(text);
  text = text.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (_match, entity: string) => HTML_ENTITY_MAP[entity] ?? _match,
  );
  // Strip unterminated tag-like fragments that can remain after entity decode,
  // e.g. "&lt;script attr=" -> "<script attr=".
  text = text.replace(/<[A-Za-z!/][^>\n]*(?=\n|$)/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * Email-specific HTML-to-plain-text conversion.
 *
 * Extends the general strip with:
 * - `<hr>` tags converted to `\n---\n` (reply separators)
 * - `<blockquote>` converted to `> ` prefixed lines (email threading)
 * - Whitespace cleanup preserving intentional line breaks
 */
export function stripHtmlEmail(html: string): string {
  let result = html;

  // Handle horizontal rules FIRST (often used as reply separators)
  // Must be before tag stripping since <hr> may have attributes
  result = result.replace(/<hr[^>]*\/?>/gi, "\n---\n");

  // Replace common block elements with newlines
  result = result.replace(/<br\s*\/?>/gi, "\n");
  result = result.replace(/<\/p>/gi, "\n\n");
  result = result.replace(/<\/div>/gi, "\n");
  result = result.replace(/<\/h[1-6]>/gi, "\n\n");
  result = result.replace(/<\/li>/gi, "\n");

  // Handle blockquotes (common in email replies) with ">" prefix
  // Process iteratively to handle nested blockquotes from outside-in
  let previousResult = "";
  while (previousResult !== result) {
    previousResult = result;
    result = result.replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_match, content) => {
        // Strip tags from content but don't process blockquotes yet
        const strippedContent = content
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n")
          .replace(/<\/div>/gi, "\n")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/[ \t]+/g, " ")
          .trim();
        const lines = strippedContent.split("\n");
        return `\n${lines
          .map((line: string) => `> ${line.trim()}`)
          .join("\n")}\n`;
      },
    );
  }

  // Strip remaining tags
  result = result.replace(/<[^>]*>/g, " ");

  // Decode common HTML entities
  // Note: &amp; must be decoded LAST to prevent double-unescaping
  // (e.g., &amp;lt; should become &lt; not <)
  result = result.replace(/&nbsp;/gi, " ");
  result = result.replace(/&lt;/gi, "<");
  result = result.replace(/&gt;/gi, ">");
  result = result.replace(/&quot;/gi, '"');
  result = result.replace(/&#39;/gi, "'");
  result = result.replace(/&amp;/gi, "&");

  // Clean up whitespace while preserving intentional line breaks
  result = result.replace(/[ \t]+/g, " ");
  result = result.replace(/\n +/g, "\n");
  result = result.replace(/ +\n/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

// ===== Internal =====

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

const MAX_TAG_STRIP_ITERATIONS = 50;

function stripTagsIteratively(text: string): string {
  let stripped = text;
  let previous = "";
  let iterations = 0;

  while (stripped !== previous && iterations < MAX_TAG_STRIP_ITERATIONS) {
    previous = stripped;
    stripped = stripped.replace(/<[^>]+>/g, "");
    iterations++;
  }

  return stripped;
}
