import type { UIMessage } from "ai";
import type { archestraApiTypes } from "@shared";

export type PersistedChatError =
  archestraApiTypes.GetChatConversationResponses["200"]["chatErrors"][number];

export type UnsafeContextBoundary =
  archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];

export type MockChatScenarioMode = "stream" | "seeded" | "hybrid";

export type ChatScenarioEvent =
  | {
      type: "assistant-text";
      text: string;
      id?: string;
      delayMs?: number;
    }
  | {
      type: "assistant-reasoning";
      text: string;
      id?: string;
      delayMs?: number;
    }
  | {
      type: "user-text";
      text: string;
      delayMs?: number;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      dynamic?: boolean;
      title?: string;
      providerExecuted?: boolean;
      delayMs?: number;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      result:
        | {
            state: "output-available";
            output: unknown;
            dynamic?: boolean;
            preliminary?: boolean;
          }
        | {
            state: "output-error";
            errorText: string;
            dynamic?: boolean;
          }
        | {
            state: "output-denied";
          };
      delayMs?: number;
    }
  | {
      type: "data-tool-ui-start";
      toolCallId: string;
      toolName: string;
      uiResourceUri: string;
      html?: string;
      csp?: { connectDomains?: string[]; resourceDomains?: string[] };
      permissions?: {
        camera?: boolean;
        microphone?: boolean;
        geolocation?: boolean;
        clipboardWrite?: boolean;
      };
      delayMs?: number;
    }
  | {
      type: "delay";
      ms: number;
    }
  | {
      type: "finish";
      finishReason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
      delayMs?: number;
    }
  | {
      type: "error";
      errorText: string;
      delayMs?: number;
    };

export type MockChatScenario = {
  id: string;
  mode: MockChatScenarioMode;
  route: {
    initialPath: string;
    conversationId: string;
  };
  request?: {
    assertLastUserMessageIncludes?: string;
  };
  seededConversation?: {
    messages: UIMessage[];
    chatErrors?: PersistedChatError[];
    unsafeContextBoundary?: UnsafeContextBoundary;
  };
  stream?: {
    events: ChatScenarioEvent[];
  };
  assertions: {
    visibleText: string[];
    visibleButtons?: string[];
    visibleImages?: string[];
    orderedText?: string[];
    hiddenText?: string[];
  };
};
