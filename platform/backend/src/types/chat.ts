export type ChatMessagePart = {
  type: string;
  output?: unknown;
  result?: unknown;
  toolName?: string;
  text?: string;
  toolCallId?: string;
  source?: unknown;
  // Chat history normalization touches loosely-typed UI message parts coming
  // from the AI SDK and persisted JSON payloads, so this remains permissive
  // until we have a stable discriminated union for all supported part shapes.
  [key: string]: unknown;
};

export type ChatMessage = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  parts?: ChatMessagePart[];
};
