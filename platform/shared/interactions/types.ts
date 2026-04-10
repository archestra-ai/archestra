import type { UIMessage } from "ai";

export type BlockedToolPart = {
  type: "blocked-tool";
  toolName: string;
  toolArguments?: string;
  reason: string;
  fullRefusal?: string;
};

export type PolicyDeniedPart = {
  type: string;
  toolCallId: string;
  state: "output-denied";
  input: Record<string, unknown>;
  errorText: string;
  unsafeContextActiveAtRequestStart?: boolean;
};

export type DualLlmPart = {
  type: "dual-llm-analysis";
  toolCallId: string;
  safeResult: string;
  conversations: Array<{
    role: "user" | "assistant";
    content: string | unknown;
  }>;
};

export type PartialUIMessage = Partial<UIMessage> & {
  role: UIMessage["role"];
  parts: (
    | UIMessage["parts"][number]
    | BlockedToolPart
    | DualLlmPart
    | PolicyDeniedPart
  )[];
  metadata?: {
    trusted?: boolean;
    blocked?: boolean;
    reason?: string;
  };
};
