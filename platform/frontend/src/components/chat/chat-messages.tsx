import type { UIMessage } from "@ai-sdk/react";
import type { ChatStatus } from "ai";
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
}: ChatMessagesProps) {
  const isStreamingStalled = useStreamingStallDetection(messages, status);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-lg mb-2">No messages yet</p>
          <p className="text-sm">Start a conversation by sending a message</p>
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
                    // biome-ignore lint/suspicious/noExplicitAny: Dynamic tool parts have runtime-defined properties
                    const toolName = (part as any).toolName;

                    // Look ahead for tool result (same tool call ID)
                    // biome-ignore lint/suspicious/noExplicitAny: Tool result structure varies by tool type
                    let toolResultPart: any = null;
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
                      <Tool key={`${message.id}-${part.toolCallId}`}>
                        <ToolHeader
                          type={`tool-${toolName}`}
                          state={
                            toolResultPart
                              ? "output-available"
                              : part.state || "input-available"
                          }
                        />
                        <ToolContent>
                          {part.input && Object.keys(part.input).length > 0 && (
                            <ToolInput input={part.input} />
                          )}
                          {toolResultPart && (
                            <ToolOutput
                              label={
                                toolResultPart.errorText ? "Error" : "Result"
                              }
                              output={toolResultPart.output}
                              errorText={toolResultPart.errorText}
                            />
                          )}
                          {!toolResultPart && Boolean(part.output) && (
                            <ToolOutput
                              label={part.errorText ? "Error" : "Result"}
                              output={part.output}
                              errorText={part.errorText}
                            />
                          )}
                        </ToolContent>
                      </Tool>
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
                        <Tool key={`${message.id}-${part.toolCallId}`}>
                          <ToolHeader
                            type={`tool-${toolName}`}
                            state={
                              toolResultPart
                                ? "output-available"
                                : part.state || "input-available"
                            }
                          />
                          <ToolContent>
                            {part.input &&
                              Object.keys(part.input).length > 0 && (
                                <ToolInput input={part.input} />
                              )}
                            {toolResultPart && (
                              <ToolOutput
                                label={
                                  toolResultPart.errorText ? "Error" : "Result"
                                }
                                output={toolResultPart.output}
                                errorText={toolResultPart.errorText}
                              />
                            )}
                            {!toolResultPart && Boolean(part.output) && (
                              <ToolOutput
                                label={part.errorText ? "Error" : "Result"}
                                output={part.output}
                                errorText={part.errorText}
                              />
                            )}
                          </ToolContent>
                        </Tool>
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
                className="object-contain h-8 animate-[bounce_700ms_ease_200ms_infinite]"
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
