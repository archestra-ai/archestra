const DEFAULT_SESSION_NAME = "New Chat Session";

/**
 * Preserves newlines in user message text for markdown rendering.
 *
 * Markdown treats single newlines as soft breaks (collapsed into spaces).
 * This function converts single newlines into markdown hard line breaks
 * (two trailing spaces + newline) so that user-typed line breaks are
 * visually preserved when rendered through a markdown renderer.
 *
 * Lines inside fenced code blocks (``` or ~~~) are left untouched since
 * code blocks already preserve whitespace.
 */
export function preserveNewlines(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trimStart();

    // Toggle code block state on fenced code block delimiters
    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    // Inside code blocks, preserve lines as-is
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // For the last line, don't append trailing spaces
    if (i === lines.length - 1) {
      result.push(line);
      continue;
    }

    // Append two trailing spaces for a markdown hard line break,
    // but only if the line doesn't already end with two+ spaces
    // and the line is not empty (empty lines already create paragraph breaks)
    if (line === "" || line.endsWith("  ")) {
      result.push(line);
    } else {
      result.push(`${line}  `);
    }
  }

  return result.join("\n");
}

/**
 * Generates localStorage keys scoped to a specific conversation.
 * Use this everywhere conversation-specific keys are read/written/removed
 * so that key formats stay in sync (especially for cleanup on deletion).
 */
export function conversationStorageKeys(conversationId: string) {
  return {
    artifactOpen: `archestra-chat-artifact-open-${conversationId}`,
    draft: `archestra_chat_draft_${conversationId}`,
  };
}

/**
 * Extracts a display title for a conversation.
 * Priority: explicit title > first user message > default session name
 */
export function getConversationDisplayTitle(
  title: string | null,
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[],
): string {
  if (title) return title;

  // Try to extract from first user message
  if (messages && messages.length > 0) {
    for (const msg of messages) {
      if (msg.role === "user" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            return part.text;
          }
        }
      }
    }
  }

  return DEFAULT_SESSION_NAME;
}
