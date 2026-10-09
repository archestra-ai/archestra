import type { UIMessage } from "ai";

export type BlockedToolPart = {
  type: "blocked-tool";
  toolName: string;
  toolArguments?: string;
  reason: string;
  fullRefusal?: string;
};

export type PartialUIMessage = Partial<UIMessage> & {
  role: UIMessage["role"];
  parts: (UIMessage["parts"][number] | BlockedToolPart)[];
  metadata?: {
    trusted?: boolean;
    blocked?: boolean;
    reason?: string;
  };
};
