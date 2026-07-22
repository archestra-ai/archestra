import { type ChatMessage, ChatMessageMetadataSchema } from "@archestra/shared";
import {
  DIAGNOSTICS_BLOCK_CLOSE,
  DIAGNOSTICS_BLOCK_OPEN,
  DIAGNOSTICS_UNTRUSTED_PREAMBLE,
  formatDiagnosticEntryLines,
} from "@/services/apps/app-diagnostics";
import { spliceText } from "./augment-last-user-message";

// Per-message cap on how many apps' diagnostics ride one attachment (the
// per-app entry cap + sanitization live in the shared formatter).
const MAX_APPS = 5;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * When the last user message carries `metadata.appDiagnostics` (runtime
 * errors / CSP violations the chat UI captured from owned MCP App renders),
 * append a clearly-delimited, explicitly-untrusted diagnostics block to that
 * message's text so the model can fix the app via `edit_app` without the
 * user pasting errors by hand.
 *
 * Mirrors `injectSkillActivation`: returns a shallow copy for the LLM; the
 * persisted messages and the visible bubble stay untouched. Inert when the
 * metadata is absent/malformed.
 */
export async function injectAppDiagnostics(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
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
  next[lastUserIndex] = spliceText(userMessage, block, "append");
  return next;
}
