"use client";

import type { ChatStatus, UIMessage } from "ai";
import {
  Check,
  CopyIcon,
  GlobeIcon,
  RefreshCcwIcon,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Fragment, useState } from "react";
import { Action, Actions } from "@/components/ai-elements/actions";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  type PromptInputMessage,
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
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

const models = [
  {
    name: "GPT 4o",
    value: "openai/gpt-4o",
  },
  {
    name: "Deepseek R1",
    value: "deepseek/deepseek-r1",
  },
];

const ChatBotDemo = ({
  messages,
  reload,
  isEnded,
}: {
  messages: PartialUIMessage[];
  reload?: () => void;
  isEnded?: boolean;
}) => {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string>(models[0].value);
  const [webSearch, setWebSearch] = useState(false);
  // const { messages, reload, isEnded } = useMockedMessages({ isMitigated });
  // We are mocking those parts
  // const { messages, sendMessage, status } = useChat({
  //   transport: new DefaultChatTransport({
  //     api: "/api/chat-demo",
  //   }),
  // });
  // sendMessage(
  //   {
  //     text: message.text || "Sent with attachments",
  //     files: message.files,
  //   },
  //   {
  //     body: {
  //       model: model,
  //       webSearch: webSearch,
  //     },
  //   },
  // );

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);

    if (!(hasText || hasAttachments)) {
      return;
    }

    setInput("");
  };

  const status: ChatStatus = "streaming" as ChatStatus;

  return (
    <div className="max-w-4xl mx-auto p-6 relative size-full h-screen">
      <div className="flex flex-col h-full">
        <Conversation className="h-full">
          <ConversationContent>
            {messages.map((message) => (
              <div key={message.id}>
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
                {message.metadata?.tainted && (
                  <div className="mb-2 p-3 bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-800 rounded-lg">
                    <div className="flex items-start gap-2">
                      <TriangleAlert className="size-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-red-900 dark:text-red-100">
                          Tainted Content
                        </p>
                        {message.metadata.taintReason && (
                          <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                            {message.metadata.taintReason}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {message.parts.map((part, i) => {
                  switch (part.type) {
                    case "text":
                      return (
                        <Fragment key={`${message.id}-${i}`}>
                          <Message from={message.role}>
                            <MessageContent>
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
                      const isShield = part.toolCallId === "dual_llm_activated";
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

                      return (
                        <Tool
                          defaultOpen={true}
                          key={`${message.id}-${part.toolCallId}`}
                          className={getColorClass()}
                        >
                          <ToolHeader
                            type={`tool-${toolName}`}
                            state={part.state}
                            icon={getIcon()}
                          />
                          <ToolContent>
                            {part.input &&
                            Object.keys(part.input).length > 0 ? (
                              <ToolInput input={part.input} />
                            ) : null}
                            <ToolOutput
                              output={part.output}
                              errorText={part.errorText}
                            />
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
                    default:
                      return null;
                  }
                })}
              </div>
            ))}
            {status === "submitted" && <Loader />}
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
        <PromptInput
          onSubmit={handleSubmit}
          className="mt-4"
          globalDrop
          multiple
        >
          <PromptInputBody>
            <PromptInputAttachments>
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
            <PromptInputTextarea
              onChange={(e) => setInput(e.target.value)}
              value={input}
              disabled
            />
          </PromptInputBody>
          <PromptInputToolbar>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <PromptInputButton
                variant={webSearch ? "default" : "ghost"}
                onClick={() => setWebSearch(!webSearch)}
              >
                <GlobeIcon size={16} />
                <span>Search</span>
              </PromptInputButton>
              <PromptInputModelSelect
                onValueChange={(value) => {
                  setModel(value);
                }}
                value={model}
              >
                <PromptInputModelSelectTrigger>
                  <PromptInputModelSelectValue />
                </PromptInputModelSelectTrigger>
                <PromptInputModelSelectContent>
                  {models.map((model) => (
                    <PromptInputModelSelectItem
                      key={model.value}
                      value={model.value}
                    >
                      {model.name}
                    </PromptInputModelSelectItem>
                  ))}
                </PromptInputModelSelectContent>
              </PromptInputModelSelect>
            </PromptInputTools>
            <PromptInputSubmit disabled status="ready" />
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </div>
  );
};

export type PartialUIMessage = Partial<UIMessage> & {
  role: UIMessage["role"];
  parts: UIMessage["parts"];
  metadata?: {
    tainted?: boolean;
    taintReason?: string;
  };
};

export default ChatBotDemo;
