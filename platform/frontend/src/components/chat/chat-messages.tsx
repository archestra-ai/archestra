import type { UIMessage } from "@ai-sdk/react";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart } from "ai";
import Image from "next/image";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Response } from "@/components/ai-elements/response";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";

interface ChatMessagesProps {
  messages: UIMessage[];
  hideToolCalls?: boolean;
  status: ChatStatus;
  isLoadingConversation?: boolean;
}

// Type guards for tool parts
// biome-ignore lint/suspicious/noExplicitAny: AI SDK message parts have dynamic structure
function isToolPart(part: any): part is {
  type: string;
  state?: string;
  toolCallId?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Tool inputs are dynamic based on tool schema
  input?: any;
  // biome-ignore lint/suspicious/noExplicitAny: Tool outputs are dynamic based on tool execution
  output?: any;
  errorText?: string;
} {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part.type?.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

export function ChatMessages({
  messages,
  hideToolCalls = false,
  status,
  isLoadingConversation = false,
}: ChatMessagesProps) {
  const isStreamingStalled = useStreamingStallDetection(messages, status);

  if (messages.length === 0) {
    // Don't show "start conversation" message while loading - prevents flash of empty state
    if (isLoadingConversation) {
      return null;
    }

    return (
      <div className="flex-1 flex h-full items-center justify-center p-6">
        <div className="flex flex-col items-center gap-6 max-w-md text-center">
          {/* Animated Icon Container */}
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-primary/10 blur-3xl rounded-full animate-pulse" />
            <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-border/50 flex items-center justify-center shadow-lg">
              <svg
                className="w-10 h-10 text-primary/70"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
                />
              </svg>
            </div>
          </div>

          {/* Welcome Text */}
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground">
              Ready to assist
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Start a conversation by typing a message below.
            </p>
          </div>

          {/* Feature Hints */}
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/50 border border-border/50 text-xs text-muted-foreground">
              <svg
                className="w-3.5 h-3.5 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z"
                />
              </svg>
              <span>MCP Tools</span>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/50 border border-border/50 text-xs text-muted-foreground">
              <svg
                className="w-3.5 h-3.5 text-primary/80"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
                />
              </svg>
              <span>Multiple LLMs</span>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/50 border border-border/50 text-xs text-muted-foreground">
              <svg
                className="w-3.5 h-3.5 text-primary/60"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
                />
              </svg>
              <span>Fast Responses</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Conversation className="h-full">
      <ConversationContent>
        <div className="max-w-4xl mx-auto">
          {messages.map((message, idx) => (
            <div key={message.id || idx}>
              {message.parts.map((part, i) => {
                // Skip tool result parts that immediately follow a tool invocation with same toolCallId
                if (
                  isToolPart(part) &&
                  part.state === "output-available" &&
                  i > 0
                ) {
                  const prevPart = message.parts[i - 1];
                  if (
                    isToolPart(prevPart) &&
                    prevPart.state === "input-available" &&
                    prevPart.toolCallId === part.toolCallId
                  ) {
                    return null;
                  }
                }

                // Hide tool calls if hideToolCalls is true
                if (
                  hideToolCalls &&
                  isToolPart(part) &&
                  (part.type?.startsWith("tool-") ||
                    part.type === "dynamic-tool")
                ) {
                  return null;
                }

                switch (part.type) {
                  case "text":
                    return (
                      <Fragment key={`${message.id}-${i}`}>
                        <Message from={message.role}>
                          <MessageContent>
                            {message.role === "system" && (
                              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                System Prompt
                              </div>
                            )}
                            <Response>{part.text}</Response>
                          </MessageContent>
                        </Message>
                      </Fragment>
                    );

                  case "reasoning":
                    return (
                      <Reasoning key={`${message.id}-${i}`} className="w-full">
                        <ReasoningTrigger />
                        <ReasoningContent>{part.text}</ReasoningContent>
                      </Reasoning>
                    );

                  case "dynamic-tool": {
                    if (!isToolPart(part)) return null;
                    const toolName = part.toolName;

                    // Look ahead for tool result (same tool call ID)
                    let toolResultPart = null;
                    const nextPart = message.parts[i + 1];
                    if (
                      nextPart &&
                      isToolPart(nextPart) &&
                      nextPart.type === "dynamic-tool" &&
                      nextPart.state === "output-available" &&
                      nextPart.toolCallId === part.toolCallId
                    ) {
                      toolResultPart = nextPart;
                    }

                    return (
                      <MessageTool
                        part={part}
                        key={`${message.id}-${i}`}
                        toolResultPart={toolResultPart}
                        toolName={toolName}
                      />
                    );
                  }

                  default: {
                    // Handle tool invocations (type is "tool-{toolName}")
                    if (isToolPart(part) && part.type?.startsWith("tool-")) {
                      const toolName = part.type.replace("tool-", "");

                      // Look ahead for tool result (same tool call ID)
                      // biome-ignore lint/suspicious/noExplicitAny: Tool result structure varies by tool type
                      let toolResultPart: any = null;
                      const nextPart = message.parts[i + 1];
                      if (
                        nextPart &&
                        isToolPart(nextPart) &&
                        nextPart.type?.startsWith("tool-") &&
                        nextPart.state === "output-available" &&
                        nextPart.toolCallId === part.toolCallId
                      ) {
                        toolResultPart = nextPart;
                      }

                      return (
                        <MessageTool
                          part={part}
                          key={`${message.id}-${i}`}
                          toolResultPart={toolResultPart}
                          toolName={toolName}
                        />
                      );
                    }

                    // Skip step-start and other non-renderable parts
                    return null;
                  }
                }
              })}
            </div>
          ))}
          {(status === "submitted" ||
            (status === "streaming" && isStreamingStalled)) && (
            <Message from="assistant">
              <Image
                src={"/logo.png"}
                alt="Loading logo"
                width={40}
                height={40}
                className="object-contain h-8 w-auto animate-[bounce_700ms_ease_200ms_infinite]"
              />
            </Message>
          )}
        </div>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

// Custom hook to detect when streaming has stalled (>500ms without updates)
function useStreamingStallDetection(
  messages: UIMessage[],
  status: ChatStatus,
): boolean {
  const lastUpdateTimeRef = useRef<number>(Date.now());
  const [isStreamingStalled, setIsStreamingStalled] = useState(false);

  // Update last update time when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: we need to react to messages change here
  useEffect(() => {
    if (status === "streaming") {
      lastUpdateTimeRef.current = Date.now();
      setIsStreamingStalled(false);
    }
  }, [messages, status]);

  // Check periodically if streaming has stalled
  useEffect(() => {
    if (status !== "streaming") {
      setIsStreamingStalled(false);
      return;
    }

    const interval = setInterval(() => {
      const timeSinceLastUpdate = Date.now() - lastUpdateTimeRef.current;
      if (timeSinceLastUpdate > 1_000) {
        setIsStreamingStalled(true);
      } else {
        setIsStreamingStalled(false);
      }
    }, 100); // Check every 100ms

    return () => clearInterval(interval);
  }, [status]);

  return isStreamingStalled;
}

function MessageTool({
  part,
  toolResultPart,
  toolName,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
}) {
  const outputError = toolResultPart
    ? tryToExtractErrorFromOutput(toolResultPart.output)
    : tryToExtractErrorFromOutput(part.output);
  const errorText = toolResultPart
    ? (toolResultPart.errorText ?? outputError)
    : (part.errorText ?? outputError);

  const hasInput = part.input && Object.keys(part.input).length > 0;
  const hasContent = Boolean(
    hasInput ||
      (toolResultPart && Boolean(toolResultPart.output)) ||
      (!toolResultPart && Boolean(part.output)),
  );

  return (
    <Tool className={hasContent ? "cursor-pointer" : ""}>
      <ToolHeader
        type={`tool-${toolName}`}
        state={getHeaderState({
          state: part.state || "input-available",
          toolResultPart,
          errorText,
        })}
        errorText={errorText}
        isCollapsible={hasContent}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={part.input} /> : null}
        {toolResultPart && (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={toolResultPart.output}
            errorText={errorText}
          />
        )}
        {!toolResultPart && Boolean(part.output) && (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={part.output}
            errorText={errorText}
          />
        )}
      </ToolContent>
    </Tool>
  );
}

const tryToExtractErrorFromOutput = (output: unknown) => {
  try {
    if (typeof output !== "string") return undefined;
    const json = JSON.parse(output);
    return typeof json.error === "string" ? json.error : undefined;
  } catch (_error) {
    return undefined;
  }
};
const getHeaderState = ({
  state,
  toolResultPart,
  errorText,
}: {
  state: ToolUIPart["state"] | DynamicToolUIPart["state"];
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
}) => {
  if (errorText) return "output-error";
  if (toolResultPart) return "output-available";
  return state;
};
