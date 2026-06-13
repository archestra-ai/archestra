import {
  type ChatMessage,
  ChatMessageMetadataSchema,
  type ChatMessagePart,
} from "@archestra/shared";
import config from "@/config";
import {
  DIAGNOSTICS_BLOCK_CLOSE,
  DIAGNOSTICS_BLOCK_OPEN,
  DIAGNOSTICS_UNTRUSTED_PREAMBLE,
  formatDiagnosticEntryLines,
} from "@/services/apps/app-diagnostics";

// Per-message cap on how many apps' diagnostics ride one attachment (the
// per-app entry cap + sanitization live in the shared formatter).
const MAX_APPS = 5;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * When the last user message carries `metadata.appDiagnostics` (runtime
 * errors / CSP violations the chat UI captured from owned MCP App renders),
 * append a clearly-delimited, explicitly-untrusted diagnostics block to that
 * message's text so the model can fix the app via `update_app` without the
 * user pasting errors by hand.
 *
 * Mirrors `injectSkillActivation`: returns a shallow copy for the LLM; the
 * persisted messages and the visible bubble stay untouched. Inert when the
 * apps feature is disabled or the metadata is absent/malformed.
 */
export async function injectAppDiagnostics(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  if (!config.apps.enabled) {
    return messages;
  }
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  if (lastUserIndex === -1) {
    return messages;
  }

  const userMessage = messages[lastUserIndex];
  const diagnostics = ChatMessageMetadataSchema.safeParse(userMessage.metadata)
    .data?.appDiagnostics;
  if (!diagnostics || diagnostics.length === 0) {
    return messages;
  }

  const blocks = await Promise.all(
    diagnostics
      .filter((d) => d.entries.length > 0 && UUID_PATTERN.test(d.appId))
      .slice(0, MAX_APPS)
      .map(async (d) => {
        const entries = await formatDiagnosticEntryLines(d.entries);
        const versionLabel =
          d.version !== null ? ` (version ${d.version})` : "";
        return `App ${d.appId}${versionLabel}:\n${entries}`;
      }),
  );
  if (blocks.length === 0) {
    return messages;
  }

  const block = [
    DIAGNOSTICS_BLOCK_OPEN,
    DIAGNOSTICS_UNTRUSTED_PREAMBLE,
    "",
    ...blocks,
    DIAGNOSTICS_BLOCK_CLOSE,
  ].join("\n");

  const next = [...messages];
  next[lastUserIndex] = appendText(userMessage, block);
  return next;
}

/** Append `block` to the message's last text part (adding one if absent). */
function appendText(message: ChatMessage, block: string): ChatMessage {
  const parts: ChatMessagePart[] = message.parts ? [...message.parts] : [];
  const textIndex = parts.findLastIndex((part) => part.type === "text");

  if (textIndex === -1) {
    return { ...message, parts: [...parts, { type: "text", text: block }] };
  }

  const textPart = parts[textIndex];
  const existing = typeof textPart.text === "string" ? textPart.text : "";
  parts[textIndex] = {
    ...textPart,
    text: existing ? `${existing}\n\n${block}` : block,
  };
  return { ...message, parts };
}
