export type ChatMessagePart = {
  type: string;
  output?: unknown;
  result?: unknown;
  toolName?: string;
  text?: string;
  toolCallId?: string;
  source?: unknown;
  [key: string]: unknown;
};

export type ChatMessage = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  parts?: ChatMessagePart[];
};
