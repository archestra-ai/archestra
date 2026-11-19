// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ApiError } from "@/types/api";

/**
 * Native memory jobs carry JSON inside a user message. Decode before removing
 * transport marks: removing their text from serialized JSON strands escaped
 * separators and changes the exact child value admitted by the runtime.
 */
export function parseGrokDurableHistory(text: string) {
  const opening =
    /^session_id=[A-Za-z0-9_.:-]+\r?\nfrom_turn=\d+\r?\nthrough_turn=\d+\r?\ndurable_conversation_json:\r?\n/.exec(
      text,
    );
  if (!opening) return undefined;
  if (Buffer.byteLength(text) > 8 * 1024 * 1024)
    throw new ApiError(
      409,
      "OpenAPPA withheld an oversized Grok memory transcript.",
    );
  let transcript: unknown;
  try {
    transcript = JSON.parse(text.slice(opening[0].length));
  } catch {
    throw new ApiError(
      409,
      "OpenAPPA withheld an invalid Grok memory transcript.",
    );
  }
  if (
    !Array.isArray(transcript) ||
    transcript.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  )
    throw new ApiError(
      409,
      "OpenAPPA withheld an invalid Grok memory transcript.",
    );
  const entries = transcript as Record<string, unknown>[];
  const messages: Record<string, unknown>[] = entries.map((entry) => ({
    ...entry,
    ...(entry.type === "user" || entry.type === "assistant"
      ? { role: entry.type }
      : entry.type === "tool_result"
        ? { role: "tool" }
        : {}),
  }));
  // Restoration may insert a missing tool result. Track original entries by
  // identity, not position, so an insertion cannot shift another entry's role.
  const originals = new Map(
    messages.map((entry, index) => [entry, entries[index]]),
  );
  return {
    messages,
    serialize: () =>
      opening[0] +
      JSON.stringify(
        messages.map((entry) => {
          const restored = { ...entry };
          const original = originals.get(entry);
          if (original && Object.hasOwn(original, "role"))
            restored.role = original.role;
          else delete restored.role;
          if (!original && entry.role === "tool") restored.type = "tool_result";
          return restored;
        }),
      ),
  };
}
