"use client";

import type { ChatStatus, UIMessage } from "ai";
import {
  Check,
  CopyIcon,
  RefreshCcwIcon,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Fragment } from "react";
import { Action, Actions } from "@/components/ai-elements/actions";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Response } from "@/components/ai-elements/response";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Divider from "./divider";

const ChatBotDemo = ({
  messages,
  reload,
  isEnded,
  containerClassName,
  topPart,
  hideDivider,
}: {
  messages: PartialUIMessage[];
  reload?: () => void;
  isEnded?: boolean;
  containerClassName?: string;
  topPart?: React.ReactNode;
  hideDivider?: boolean;
}) => {
  const status: ChatStatus = "streaming" as ChatStatus;

  return (
    <div
      className={cn(
        "mx-auto relative size-full h-[calc(100vh-3rem)]",
        containerClassName,
      )}
    >
      <div className="flex flex-col h-full">
        <Conversation className="h-full">
          <ConversationContent>
            {topPart}
            {!hideDivider && <Divider className="my-4" />}
            <div className="max-w-4xl mx-auto">
              {messages.map((message, idx) => (
                <div key={message.id || idx}>
                  {message.role === "assistant" &&
                    message.parts.filter((part) => part.type === "source-url")
                      .length > 0 && (
                      <Sources>
                        <SourcesTrigger
                          count={
                            message.parts.filter(
                              (part) => part.type === "source-url",
                            ).length
                          }
                        />
                        {message.parts
                          .filter((part) => part.type === "source-url")
                          .map((part, i) => (
                            <SourcesContent key={`${message.id}-${i}`}>
                              <Source
                                key={`${message.id}-${i}`}
                                href={part.url}
                                title={part.url}
                              />
                            </SourcesContent>
                          ))}
                      </Sources>
                    )}

                  {message.parts.map((part, i) => {
                    // Skip tool result parts that immediately follow a tool invocation with same toolCallId
                    if (
                      (part.type === "dynamic-tool" ||
                        part.type === "tool-invocation") &&
                      part.state === "output-available" &&
                      i > 0
                    ) {
                      const prevPart = message.parts[i - 1];
                      if (
                        (prevPart.type === "dynamic-tool" ||
                          prevPart.type === "tool-invocation") &&
                        prevPart.state === "input-available" &&
                        prevPart.toolCallId === part.toolCallId
                      ) {
                        return null;
                      }
                    }

                    // Skip dual-llm-analysis parts that follow a tool (invocation or result)
                    // They will be rendered together with the tool
                    if (_isDualLlmPart(part) && i > 0) {
                      const prevPart = message.parts[i - 1];
                      if (
                        prevPart.type === "dynamic-tool" ||
                        ("type" in prevPart &&
                          prevPart.type === "tool-invocation")
                      ) {
                        return null;
                      }
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
                            {message.role === "assistant" &&
                              i === messages.length - 1 && (
                                <Actions className="mt-2">
                                  <Action
                                    onClick={() =>
                                      navigator.clipboard.writeText(part.text)
                                    }
                                    label="Copy"
                                  >
                                    <CopyIcon className="size-3" />
                                  </Action>
                                </Actions>
                              )}
                          </Fragment>
                        );
                      case "tool-invocation":
                      case "dynamic-tool": {
                        const toolName =
                          part.type === "dynamic-tool"
                            ? part.toolName
                            : part.toolCallId;
                        const isDanger = [
                          "gather_sensitive_data",
                          "send_email",
                          "analyze_email_blocked",
                        ].includes(part.toolCallId);
                        const isShield =
                          part.toolCallId === "dual_llm_activated";
                        const isSuccess = part.toolCallId === "attack_blocked";
                        const getIcon = () => {
                          if (isDanger)
                            return (
                              <TriangleAlert className="size-4 text-muted-foreground" />
                            );
                          if (isShield)
                            return (
                              <ShieldCheck className="size-4 text-muted-foreground" />
                            );
                          if (isSuccess)
                            return (
                              <Check className="size-4 text-muted-foreground" />
                            );
                          return undefined;
                        };
                        const getColorClass = () => {
                          if (isDanger) return "bg-red-500/30";
                          if (isShield) return "bg-sky-400/60";
                          if (isSuccess) return "bg-emerald-700/60";
                          return "";
                        };

                        // Look ahead for tool result and dual LLM analysis
                        let toolResultPart = null;
                        let dualLlmPart: DualLlmPart | null = null;

                        // Check if next part is a tool result (same tool call ID)
                        const nextPart = message.parts[i + 1];
                        if (
                          nextPart &&
                          (nextPart.type === "dynamic-tool" ||
                            nextPart.type === "tool-invocation") &&
                          nextPart.state === "output-available" &&
                          nextPart.toolCallId === part.toolCallId
                        ) {
                          toolResultPart = nextPart;

                          // Check if there's a dual LLM part after the tool result
                          const dualLlmPartCandidate = message.parts[i + 2];
                          if (_isDualLlmPart(dualLlmPartCandidate)) {
                            dualLlmPart = dualLlmPartCandidate;
                          }
                        } else {
                          // Check if the next part is directly a dual LLM analysis
                          if (_isDualLlmPart(nextPart)) {
                            dualLlmPart = nextPart;
                          }
                        }

                        return (
                          <Tool
                            key={`${message.id}-${part.toolCallId}`}
                            className={getColorClass()}
                          >
                            <ToolHeader
                              type={`tool-${toolName}`}
                              state={
                                dualLlmPart
                                  ? "output-available-dual-llm"
                                  : toolResultPart
                                    ? "output-available"
                                    : part.state
                              }
                              icon={getIcon()}
                            />
                            <ToolContent>
                              {part.input &&
                              Object.keys(part.input).length > 0 ? (
                                <ToolInput input={part.input} />
                              ) : null}
                              {toolResultPart && (
                                <ToolOutput
                                  label={
                                    toolResultPart.errorText
                                      ? "Error"
                                      : dualLlmPart
                                        ? "Unsafe result"
                                        : "Result"
                                  }
                                  output={toolResultPart.output as unknown}
                                  errorText={toolResultPart.errorText}
                                />
                              )}
                              {!toolResultPart && Boolean(part.output) && (
                                <ToolOutput
                                  label={
                                    part.errorText
                                      ? "Error"
                                      : dualLlmPart
                                        ? "Unsafe result"
                                        : "Result"
                                  }
                                  output={part.output as unknown}
                                  errorText={part.errorText}
                                />
                              )}
                              {dualLlmPart && (
                                <>
                                  <ToolOutput
                                    label="Safe result"
                                    output={dualLlmPart.safeResult}
                                  />
                                  <ToolOutput
                                    label="Questions and Answers"
                                    output={undefined}
                                    conversations={dualLlmPart.conversations.slice(
                                      1,
                                    )}
                                  />
                                </>
                              )}
                            </ToolContent>
                          </Tool>
                        );
                      }
                      case "reasoning":
                        return (
                          <Reasoning
                            key={`${message.id}-${i}`}
                            className="w-full"
                            isStreaming={
                              status === "streaming" &&
                              i === message.parts.length - 1 &&
                              message.id === messages.at(-1)?.id
                            }
                          >
                            <ReasoningTrigger />
                            <ReasoningContent>{part.text}</ReasoningContent>
                          </Reasoning>
                        );
                      default: {
                        // Handle custom blocked-tool type
                        if (_isBlockedToolPart(part)) {
                          const blockedPart = part as BlockedToolPart;
                          return (
                            <div
                              key={`${message.id}-${i}`}
                              className="my-2 p-4 bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 rounded-lg"
                            >
                              <div className="flex items-start gap-3">
                                <TriangleAlert className="size-5 text-destructive dark:text-red-400 mt-0.5 flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-2">
                                    <p className="text-sm font-semibold text-red-900 dark:text-red-100">
                                      {blockedPart.reason}
                                    </p>
                                  </div>
                                  <div className="space-y-2">
                                    <div className="flex items-center gap-2 text-xs">
                                      <span className="font-medium text-red-800 dark:text-red-200">
                                        Tool:
                                      </span>
                                      <code className="px-2 py-1 bg-red-100 dark:bg-red-900/50 rounded text-red-900 dark:text-red-100">
                                        {blockedPart.toolName}
                                      </code>
                                    </div>
                                    {blockedPart.toolArguments && (
                                      <div className="flex items-center gap-2 text-xs">
                                        <span className="font-medium text-red-800 dark:text-red-200 flex-shrink-0">
                                          Arguments:
                                        </span>
                                        <code className="px-2 py-1 bg-red-100 dark:bg-red-900/50 rounded text-red-900 dark:text-red-100 break-all">
                                          {blockedPart.toolArguments}
                                        </code>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        }

                        // Handle custom dual-llm-analysis type (standalone, not following a tool)
                        if (_isDualLlmPart(part)) {
                          const dualLlmPart = part as DualLlmPart;

                          return (
                            <Tool
                              key={`${message.id}-dual-llm-${i}`}
                              className="bg-sky-400/20"
                            >
                              <ToolHeader
                                type="tool-dual-llm-action"
                                state="output-available-dual-llm"
                                icon={
                                  <ShieldCheck className="size-4 text-muted-foreground" />
                                }
                              />
                              <ToolContent>
                                <ToolOutput
                                  label="Safe result"
                                  output={dualLlmPart.safeResult}
                                />
                                <ToolOutput
                                  label="Questions and answers"
                                  output={undefined}
                                  conversations={dualLlmPart.conversations.slice(
                                    1,
                                  )}
                                />
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      }
                    }
                  })}
                </div>
              ))}
              {status === "submitted" && <Loader />}
            </div>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        {isEnded && reload && (
          <Button
            onClick={reload}
            variant="ghost"
            className="my-2 cursor-pointer w-fit mx-auto"
          >
            <RefreshCcwIcon /> Start again
          </Button>
        )}
      </div>
    </div>
  );
};

export type BlockedToolPart = {
  type: "blocked-tool";
  toolName: string;
  toolArguments?: string;
  reason: string;
  fullRefusal?: string;
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
  parts: (UIMessage["parts"][number] | BlockedToolPart | DualLlmPart)[];
  metadata?: {
    trusted?: boolean;
    blocked?: boolean;
    reason?: string;
  };
};

// Type guards for custom part types
function _isDualLlmPart(part: unknown): part is DualLlmPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part as { type: string }).type === "dual-llm-analysis"
  );
}

function _isBlockedToolPart(part: unknown): part is BlockedToolPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part as { type: string }).type === "blocked-tool"
  );
}

export default ChatBotDemo;
