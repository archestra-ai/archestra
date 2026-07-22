import { archestraApiSdk } from "@archestra/shared";
import type { AppRecordingBundle } from "@/lib/app-session-recording/app-recording-store";

type TranscriptMessage = AppRecordingBundle["recording"]["transcript"][number];
type TranscriptPart = TranscriptMessage["parts"][number];

/**
 * The whole conversation is captured — no message cap. A session recorded after
 * the app was already built still carries the complete build history from the
 * very first message. The per-text-block bound only guards against a single
 * pathological megabyte, never real messages.
 */
const MAX_PART_TEXT = 100_000;
/** Messages sent within this settle pad after stop still belong to the demo. */
const STOP_PAD_MS = 2_000;

/**
 * Snapshot a conversation's chat transcript into the recording bundle, client
 * side, from the same messages the chat renders — the complete raw agentic
 * session, condensed to text and tool-activity markers, never truncated. Offsets
 * are relative to recording start; negatives are the history that predates the
 * recording. Best-effort: any failure yields an empty transcript rather than
 * blocking the recording from being saved.
 *
 * Also returns the conversation's `modelId` — fetched as part of the same
 * request, so the bundle's "LLM model used" gallery fact costs no extra call.
 */
export async function snapshotConversationTranscript(params: {
  conversationId: string;
  startedAtMs: number;
  durationMs: number;
}): Promise<{ transcript: TranscriptMessage[]; modelId: string | null }> {
  try {
    const { data } = await archestraApiSdk.getChatConversation({
      path: { id: params.conversationId },
    });
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const cutoff = params.startedAtMs + params.durationMs + STOP_PAD_MS;
    const transcript: TranscriptMessage[] = [];
    for (const raw of messages) {
      if (!raw || typeof raw !== "object") continue;
      const message = raw as {
        id?: unknown;
        role?: unknown;
        parts?: unknown;
        metadata?: unknown;
      };
      if (typeof message.id !== "string" || typeof message.role !== "string") {
        continue;
      }
      const atEpochMs = createdAtMs(message.metadata);
      if (atEpochMs !== null && atEpochMs > cutoff) continue;
      const parts = condenseParts(message.parts);
      if (parts.length === 0) continue;
      transcript.push({
        id: message.id,
        role: message.role,
        // No timestamp → treat as pre-recording history (shown immediately).
        atMs: atEpochMs === null ? -1 : atEpochMs - params.startedAtMs,
        parts,
      });
    }
    const modelId =
      data && typeof (data as { modelId?: unknown }).modelId === "string"
        ? (data as { modelId: string }).modelId
        : null;
    return { transcript, modelId };
  } catch {
    return { transcript: [], modelId: null };
  }
}

function createdAtMs(metadata: unknown): number | null {
  const createdAt = (metadata as { createdAt?: unknown } | null)?.createdAt;
  if (typeof createdAt !== "string") return null;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Condense an AI-SDK UIMessage's parts into the player's transcript parts, in
 * order: text blocks (capped) and tool-activity markers. Everything else
 * (reasoning, files, step markers) is presentation the demo player doesn't
 * replay.
 */
function condenseParts(parts: unknown): TranscriptPart[] {
  if (!Array.isArray(parts)) return [];
  const condensed: TranscriptPart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as {
      type?: unknown;
      text?: unknown;
      toolName?: unknown;
      input?: unknown;
    };
    if (typeof candidate.type !== "string") continue;
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.trim()
    ) {
      condensed.push({
        type: "text",
        text: candidate.text.slice(0, MAX_PART_TEXT),
      });
      continue;
    }
    const rawName =
      candidate.type === "dynamic-tool"
        ? typeof candidate.toolName === "string"
          ? candidate.toolName
          : null
        : candidate.type.startsWith("tool-")
          ? candidate.type.slice("tool-".length)
          : null;
    if (rawName) condensed.push(toolPart(rawName, candidate.input));
  }
  return condensed;
}

/**
 * Resolve a tool part to what the player shows. A `run_tool` dispatch carries
 * its real target in `tool_name`, so the marker follows the target (its icon
 * and label), not the dispatcher. A `load_skill` call carries the skill's name,
 * which becomes the marker's label so it reads "Skill: <name>" like live chat.
 */
function toolPart(rawName: string, input: unknown): TranscriptPart {
  const args =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  if (rawName.endsWith("run_tool")) {
    const target = args.tool_name;
    if (typeof target === "string" && target) {
      return { type: "tool", name: target };
    }
  }
  if (rawName.endsWith("load_skill")) {
    const skill = args.name;
    return typeof skill === "string" && skill
      ? { type: "tool", name: rawName, label: skill }
      : { type: "tool", name: rawName };
  }
  return { type: "tool", name: rawName };
}
