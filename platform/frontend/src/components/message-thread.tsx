"use client";

import {
  type archestraApiTypes,
  type BlockedToolPart,
  extractMcpToolError,
  foldCitationSources,
  isMediaNotKept,
  MEDIA_NOT_KEPT_REASON,
  type PartialUIMessage,
} from "@archestra/shared";
import type { ChatStatus } from "ai";
import {
  Check,
  FileAudio,
  FileVideo2,
  FileX,
  ImageOff,
  Paperclip,
  RefreshCcwIcon,
  TriangleAlert,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
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
import { AttachmentAudio } from "@/components/chat/attachment-content";
import {
  isBlankReasoningPart,
  stripAssistantProtocolMarkers,
} from "@/components/chat/chat-messages.utils";
import { InlineChatError } from "@/components/chat/inline-chat-error";
import {
  hasKnowledgeBaseToolCall,
  KnowledgeGraphCitations,
} from "@/components/chat/knowledge-graph-citations";
import { MessageActions } from "@/components/chat/message-actions";
import { UserMessageText } from "@/components/chat/user-message-text";
import Divider from "@/components/divider";
import {
  type EmbeddingPartData,
  EmbeddingVectors,
} from "@/components/embedding-vectors";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";

type PersistedChatError =
  archestraApiTypes.GetChatConversationResponses["200"]["chatErrors"][number];

type TimelineItem =
  | { kind: "message"; message: PartialUIMessage; messageIndex: number }
  | { kind: "chat-error"; chatError: PersistedChatError };

const MessageThread = ({
  messages,
  chatErrors = [],
  conversationId,
  reload,
  isEnded,
  containerClassName,
  topPart,
  hideDivider,
  agentName,
  selectedModel,
  openPendingTools = false,
}: {
  messages: PartialUIMessage[];
  chatErrors?: PersistedChatError[];
  conversationId?: string;
  reload?: () => void;
  isEnded?: boolean;
  containerClassName?: string;
  topPart?: React.ReactNode;
  hideDivider?: boolean;
  agentName?: string;
  selectedModel?: string;
  /**
   * Open a tool call that has no result yet. A logged request that ends on
   * one is waiting on it, so it is what a reader opened the request to see.
   */
  openPendingTools?: boolean;
}) => {
  const status: ChatStatus = "streaming" as ChatStatus;
  const { data: organization } = useOrganization();
  const timelineItems = useMemo(
    () => buildMessageTimeline({ messages, chatErrors }),
    [messages, chatErrors],
  );

  const lastAssistantMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  }, [messages]);
  return (
    <div
      className={cn(
        "mx-auto relative size-full h-[calc(100dvh-3rem)]",
        containerClassName,
      )}
    >
      <div className="flex flex-col h-full">
        <Conversation className="h-full">
          <ConversationContent>
            {topPart}
            {!hideDivider && <Divider className="my-4" />}
            <div className="max-w-4xl mx-auto">
              {timelineItems.map((item) => {
                if (item.kind === "chat-error") {
                  return (
                    <InlineChatError
                      key={`chat-error-${item.chatError.id}`}
                      error={new Error(JSON.stringify(item.chatError.error))}
                      conversationId={conversationId}
                      supportMessage={organization?.chatErrorSupportMessage}
                      slimChatErrorUi={organization?.slimChatErrorUi ?? false}
                      agentName={agentName}
                      selectedModel={selectedModel}
                    />
                  );
                }

                const { message, messageIndex: idx } = item;

                return (
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
                            .map((part) => (
                              <SourcesContent key={part.url}>
                                <Source href={part.url} title={part.url} />
                              </SourcesContent>
                            ))}
                        </Sources>
                      )}

                    {(() => {
                      const partKeyTracker = new Map<string, number>();
                      return message.parts.map((part, i) => {
                        const partKey = getPartKey(
                          message.id,
                          part,
                          partKeyTracker,
                        );
                        // Skip tool result parts that immediately follow a tool invocation with same toolCallId
                        if (
                          (part.type === "dynamic-tool" ||
                            part.type === "tool-invocation" ||
                            _isToolPrefixedPart(part)) &&
                          (part as { state?: string }).state ===
                            "output-available" &&
                          i > 0
                        ) {
                          const prevPart = message.parts[i - 1];
                          if (
                            (prevPart.type === "dynamic-tool" ||
                              prevPart.type === "tool-invocation" ||
                              _isToolPrefixedPart(prevPart)) &&
                            (prevPart as { state?: string }).state ===
                              "input-available" &&
                            (prevPart as { toolCallId?: string }).toolCallId ===
                              (part as { toolCallId?: string }).toolCallId
                          ) {
                            return null;
                          }
                        }

                        switch (part.type) {
                          case "text": {
                            // Some models emit whitespace-only text alongside
                            // tool calls (e.g. a lone " "); rendering it would
                            // produce an empty message bubble
                            if (!part.text.trim()) {
                              return null;
                            }
                            const isLastAssistantMessage =
                              message.role === "assistant" &&
                              idx === lastAssistantMessageIndex;
                            const isLastTextPartInMessage =
                              isLastAssistantMessage &&
                              message.parts
                                .slice(i + 1)
                                .every((p) => p.type !== "text");
                            // Show citations on the last text part of the last
                            // assistant message, scoped to the current assistant turn
                            // (stop at the next user message to avoid stale citations).
                            let citationParts: typeof message.parts | undefined;
                            if (isLastTextPartInMessage) {
                              if (
                                hasKnowledgeBaseToolCall(message.parts ?? [])
                              ) {
                                citationParts = message.parts;
                              } else {
                                for (
                                  let prevIdx = idx - 1;
                                  prevIdx >= 0;
                                  prevIdx--
                                ) {
                                  const prev = messages[prevIdx];
                                  if (prev.role === "user") break;
                                  if (
                                    prev.role === "assistant" &&
                                    hasKnowledgeBaseToolCall(prev.parts ?? [])
                                  ) {
                                    citationParts = prev.parts;
                                    break;
                                  }
                                }
                              }
                            }

                            // Fold the machine-oriented Sources block (quotes +
                            // chunk refs for the verifier) out of the visible
                            // text; the citation chips re-present the quotes.
                            const citationFold =
                              citationParts && message.role === "assistant"
                                ? foldCitationSources(
                                    stripAssistantProtocolMarkers(part.text),
                                  )
                                : null;
                            const visibleText =
                              message.role === "assistant"
                                ? stripAssistantProtocolMarkers(part.text)
                                : part.text;

                            return (
                              <Fragment key={partKey}>
                                <Message from={message.role}>
                                  <MessageContent>
                                    {message.role === "system" && (
                                      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                        System Prompt
                                      </div>
                                    )}
                                    {message.role === "user" ? (
                                      <UserMessageText text={part.text} />
                                    ) : (
                                      <Response>
                                        {citationFold &&
                                        citationFold.entries.length > 0
                                          ? citationFold.displayText
                                          : visibleText}
                                      </Response>
                                    )}
                                    {citationParts && (
                                      <KnowledgeGraphCitations
                                        parts={citationParts}
                                        citedQuotes={citationFold?.entries}
                                      />
                                    )}
                                  </MessageContent>
                                </Message>
                                {message.role === "assistant" &&
                                  i === messages.length - 1 && (
                                    <MessageActions
                                      textToCopy={visibleText}
                                      className="-mt-1 w-fit"
                                    />
                                  )}
                              </Fragment>
                            );
                          }
                          case "file": {
                            return (
                              <LoggedFilePart
                                key={partKey}
                                part={
                                  part as {
                                    url: string;
                                    mediaType: string;
                                    filename?: string;
                                  }
                                }
                                fromUser={message.role === "user"}
                                conversationId={conversationId}
                              />
                            );
                          }
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
                            const isSuccess =
                              part.toolCallId === "attack_blocked";
                            const getIcon = () => {
                              if (isDanger)
                                return (
                                  <TriangleAlert className="size-4 text-muted-foreground" />
                                );
                              if (isSuccess)
                                return (
                                  <Check className="size-4 text-muted-foreground" />
                                );
                              return undefined;
                            };
                            const getColorClass = () => {
                              if (isDanger) return "bg-red-500/30";
                              if (isSuccess) return "bg-emerald-700/60";
                              return "";
                            };

                            // Look ahead for the tool result
                            let toolResultPart = null;

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
                            }

                            return (
                              <Tool
                                key={part.toolCallId ?? partKey}
                                className={getColorClass()}
                                defaultOpen={
                                  openPendingTools &&
                                  !toolResultPart &&
                                  isPendingToolState(part.state)
                                }
                              >
                                <ToolHeader
                                  type={`tool-${toolName}`}
                                  state={
                                    isCancelledToolOutput(
                                      toolResultPart?.output ?? part.output,
                                    )
                                      ? "output-cancelled"
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
                                        isCancelledToolOutput(
                                          toolResultPart.output,
                                        )
                                          ? "Cancelled"
                                          : toolResultPart.errorText
                                            ? "Error"
                                            : "Result"
                                      }
                                      output={toolResultPart.output as unknown}
                                      errorText={toolResultPart.errorText}
                                    />
                                  )}
                                  {!toolResultPart && Boolean(part.output) && (
                                    <ToolOutput
                                      label={
                                        isCancelledToolOutput(part.output)
                                          ? "Cancelled"
                                          : part.errorText
                                            ? "Error"
                                            : "Result"
                                      }
                                      output={part.output as unknown}
                                      errorText={part.errorText}
                                    />
                                  )}
                                </ToolContent>
                              </Tool>
                            );
                          }
                          case "reasoning":
                            // Empty reasoning parts (redacted/signature-only
                            // thinking, kept for provider replay) must not render
                            // as empty "Thinking…" accordions.
                            if (isBlankReasoningPart(part)) {
                              return null;
                            }
                            // One accordion per part, deliberately. Chat folds
                            // adjacent thinking into runs, but that helper
                            // models chat's visible-part set, which this view
                            // does not share — it draws blocked-tool blocks the
                            // helper would treat as invisible and merge across,
                            // reordering the transcript. Tool cards here separate thinking
                            // anyway, so the folding has little to do.
                            return (
                              <Reasoning
                                key={partKey}
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
                            if (part.type === "data-embedding") {
                              return (
                                <div key={partKey} className="py-1">
                                  <EmbeddingVectors
                                    data={
                                      (part as { data: EmbeddingPartData }).data
                                    }
                                  />
                                </div>
                              );
                            }
                            if (part.type === "data-missing-media") {
                              return (
                                <MissingMedia
                                  key={partKey}
                                  media={
                                    (part as { data: MissingMediaData }).data
                                  }
                                  fromUser={message.role === "user"}
                                />
                              );
                            }
                            // Handle custom blocked-tool type
                            if (_isBlockedToolPart(part)) {
                              const blockedPart = part as BlockedToolPart;
                              return (
                                <div
                                  key={partKey}
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

                            // Handle tool-* prefixed parts (persisted tool calls from DB)
                            if (_isToolPrefixedPart(part)) {
                              // Look ahead for the tool result
                              let toolResultPart = null;

                              const nextPart = message.parts[i + 1];
                              if (
                                nextPart &&
                                _isToolPrefixedPart(nextPart) &&
                                nextPart.state === "output-available" &&
                                nextPart.toolCallId === part.toolCallId
                              ) {
                                toolResultPart = nextPart;
                              }

                              return (
                                <Tool
                                  key={`${message.id}-${part.toolCallId}`}
                                  defaultOpen={
                                    openPendingTools &&
                                    !toolResultPart &&
                                    isPendingToolState(part.state)
                                  }
                                >
                                  <ToolHeader
                                    type={part.type}
                                    state={
                                      isCancelledToolOutput(
                                        toolResultPart?.output ?? part.output,
                                      )
                                        ? "output-cancelled"
                                        : toolResultPart
                                          ? "output-available"
                                          : part.state
                                    }
                                  />
                                  <ToolContent>
                                    {part.input &&
                                    typeof part.input === "object" &&
                                    Object.keys(
                                      part.input as Record<string, unknown>,
                                    ).length > 0 ? (
                                      <ToolInput input={part.input} />
                                    ) : null}
                                    {toolResultPart && (
                                      <ToolOutput
                                        label={
                                          isCancelledToolOutput(
                                            toolResultPart.output,
                                          )
                                            ? "Cancelled"
                                            : toolResultPart.errorText
                                              ? "Error"
                                              : "Result"
                                        }
                                        output={
                                          toolResultPart.output as unknown
                                        }
                                        errorText={
                                          toolResultPart.errorText as
                                            | string
                                            | undefined
                                        }
                                      />
                                    )}
                                    {!toolResultPart &&
                                      Boolean(part.output) && (
                                        <ToolOutput
                                          label={
                                            isCancelledToolOutput(part.output)
                                              ? "Cancelled"
                                              : part.errorText
                                                ? "Error"
                                                : "Result"
                                          }
                                          output={part.output as unknown}
                                          errorText={
                                            part.errorText as string | undefined
                                          }
                                        />
                                      )}
                                  </ToolContent>
                                </Tool>
                              );
                            }

                            return null;
                          }
                        }
                      });
                    })()}
                  </div>
                );
              })}
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

export type { BlockedToolPart, PartialUIMessage };

// Type guard for tool-* prefixed parts (persisted tool calls from DB)
function _isToolPrefixedPart(part: unknown): part is {
  type: string;
  toolCallId: string;
  state: string;
  input: unknown;
  output: unknown;
  errorText?: string;
} {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof (part as { type: string }).type === "string" &&
    (part as { type: string }).type.startsWith("tool-") &&
    "toolCallId" in part
  );
}

// Type guard for custom part types
function _isBlockedToolPart(part: unknown): part is BlockedToolPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part as { type: string }).type === "blocked-tool"
  );
}

export default MessageThread;

function buildMessageTimeline(params: {
  messages: PartialUIMessage[];
  chatErrors: PersistedChatError[];
}): TimelineItem[] {
  const sortedChatErrors = [...params.chatErrors].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const timelineItems: TimelineItem[] = [];
  let errorIndex = 0;

  params.messages.forEach((message, messageIndex) => {
    const messageCreatedAt = getMessageCreatedAt(message);
    while (
      errorIndex < sortedChatErrors.length &&
      messageCreatedAt !== null &&
      Date.parse(sortedChatErrors[errorIndex].createdAt) <= messageCreatedAt
    ) {
      timelineItems.push({
        kind: "chat-error",
        chatError: sortedChatErrors[errorIndex],
      });
      errorIndex++;
    }

    timelineItems.push({ kind: "message", message, messageIndex });
  });

  for (; errorIndex < sortedChatErrors.length; errorIndex++) {
    timelineItems.push({
      kind: "chat-error",
      chatError: sortedChatErrors[errorIndex],
    });
  }

  return timelineItems;
}

function getMessageCreatedAt(message: PartialUIMessage): number | null {
  const metadata = message.metadata as { createdAt?: unknown } | undefined;
  if (typeof metadata?.createdAt !== "string") {
    return null;
  }

  const createdAt = Date.parse(metadata.createdAt);
  return Number.isNaN(createdAt) ? null : createdAt;
}

function getPartKey(
  messageId: string | undefined,
  part: PartialUIMessage["parts"][number],
  keyTracker: Map<string, number>,
): string {
  const signature = getPartSignature(part);
  const occurrence = keyTracker.get(signature) ?? 0;
  keyTracker.set(signature, occurrence + 1);
  return `${messageId ?? "message"}-${signature}-${occurrence}`;
}

function getPartSignature(part: PartialUIMessage["parts"][number]): string {
  switch (part.type) {
    case "text":
      return `text:${part.text}`;
    case "reasoning":
      return `reasoning:${part.text}`;
    case "file":
      return `file:${part.url}:${part.mediaType}:${part.filename ?? ""}`;
    case "dynamic-tool":
    case "tool-invocation":
      return `tool:${part.toolCallId ?? part.type}`;
    case "source-url":
      return `source:${part.url}`;
    default:
      if (_isToolPrefixedPart(part)) {
        return `tool:${(part as { toolCallId?: string }).toolCallId ?? part.type}`;
      }
      return `part:${JSON.stringify(part)}`;
  }
}

/**
 * A tool result the run's user cancelled mid-flight (stopped run or cancelled
 * background task), detected through the shared schema-validated extractor —
 * rendered as its own Cancelled state, neither a success nor an error.
 */
function isCancelledToolOutput(output: unknown): boolean {
  return extractMcpToolError(output)?.type === "cancelled";
}

function isPendingToolState(state: string | undefined): boolean {
  return state === "input-available" || state === "input-streaming";
}

// ============================================================================
// Logged media
// ============================================================================

type MissingMediaData = {
  kind: "audio" | "image" | "video" | "file";
  label: string;
  reason: string;
};

const MISSING_MEDIA_ICON = {
  audio: FileAudio,
  image: ImageOff,
  video: FileVideo2,
  file: FileX,
} as const;

/**
 * A file a logged call carried: an image shown inline, audio in the chat's
 * player, anything else as a named chip. The caption (format, size, length)
 * is one grey line under the media. A user's media sits on their side.
 */
function LoggedFilePart({
  part,
  fromUser,
  conversationId,
}: {
  part: { url: string; mediaType: string; filename?: string };
  fromUser: boolean;
  conversationId: string | undefined;
}) {
  const isImage = part.mediaType?.startsWith("image/");
  const isAudio = part.mediaType?.startsWith("audio/");
  // A renderer that builds its own link around stripped bytes still lands
  // here; say what was there instead of showing a broken image or player.
  if (isMediaNotKept(part.url)) {
    const kind = isImage
      ? "image"
      : isAudio
        ? "audio"
        : part.mediaType?.startsWith("video/")
          ? "video"
          : "file";
    return (
      <MissingMedia
        media={{
          kind,
          label:
            part.filename ||
            { image: "Image", audio: "Audio", video: "Video", file: "File" }[
              kind
            ],
          reason: MEDIA_NOT_KEPT_REASON,
        }}
        fromUser={fromUser}
      />
    );
  }
  if (!isImage && !isAudio) {
    return (
      <div
        className={cn("flex py-1", fromUser ? "justify-end" : "justify-start")}
      >
        <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-2 text-sm">
          <Paperclip className="size-4 text-muted-foreground" />
          <span className="truncate">{part.filename || "Attached file"}</span>
        </div>
      </div>
    );
  }
  return (
    <figure
      className={cn(
        "flex flex-col gap-1.5 py-1",
        fromUser ? "items-end" : "items-start",
      )}
    >
      {isImage ? (
        <LoggedImage url={part.url} alt={part.filename || "Image"} />
      ) : (
        <AttachmentAudio
          url={part.url}
          conversationId={conversationId}
          label={part.filename || "Audio"}
        />
      )}
      {part.filename ? (
        <figcaption className="text-xs text-muted-foreground tabular-nums">
          {part.filename}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** An image, or a note when its link no longer loads (provider links expire). */
function LoggedImage({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <MissingMedia
        media={{
          kind: "image",
          label: alt,
          reason: "The provider's link to this image no longer loads",
        }}
        fromUser={false}
      />
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      onError={() => setFailed(true)}
      className="max-h-64 max-w-full rounded-lg border object-contain"
    />
  );
}

/** Media the call carried that the log did not keep, named, with the reason. */
function MissingMedia({
  media,
  fromUser,
}: {
  media: MissingMediaData;
  fromUser: boolean;
}) {
  const Icon = MISSING_MEDIA_ICON[media.kind] ?? FileX;
  return (
    <div
      className={cn("flex py-1", fromUser ? "justify-end" : "justify-start")}
    >
      <div className="flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm">
        <Icon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="truncate font-medium tabular-nums">{media.label}</span>
        <span className="truncate text-muted-foreground">{media.reason}</span>
      </div>
    </div>
  );
}
