"use client";

import type { ReasoningUIPart } from "ai";
import { FileTextIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Sources } from "@/components/ai-elements/sources";
import { cn } from "@/lib/utils";
import type { MessageSource } from "./chat-messages.utils";

export type FileMessagePart = {
  type: "file";
  url: string;
  mediaType: string;
  filename?: string;
};

export function ChatPartBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-chat-part-block className={cn("pb-8", className)}>
      {children}
    </div>
  );
}

export function ToolPartBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ChatPartBlock className={cn("px-4", className)}>{children}</ChatPartBlock>
  );
}

export function MessageSources({ sources }: { sources: MessageSource[] }) {
  if (sources.length === 0) return null;

  return (
    <Sources className="-mt-1 mb-0">
      <Sources.Trigger count={sources.length} />
      <Sources.Content>
        {sources.map((source) => {
          if (source.kind === "url") {
            return (
              <Sources.Source
                href={source.url}
                key={source.key}
                title={source.title}
              />
            );
          }

          return (
            <div
              className="flex items-start gap-2 text-muted-foreground"
              key={source.key}
            >
              <FileTextIcon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <div className="truncate font-medium text-primary">
                  {source.title}
                </div>
                <div className="truncate">
                  {[source.filename, source.mediaType]
                    .filter(Boolean)
                    .join(" - ")}
                </div>
              </div>
            </div>
          );
        })}
      </Sources.Content>
    </Sources>
  );
}

export function ReasoningPartBlock(reasoning: ReasoningUIPart) {
  return (
    <Reasoning className="w-full mb-0" {...reasoning}>
      <Reasoning.Trigger />
      <Reasoning.Content>{reasoning.text}</Reasoning.Content>
    </Reasoning>
  );
}

export function FilePartBlock({ file }: { file: FileMessagePart }) {
  const isImage = file.mediaType?.startsWith("image/");
  const isVideo = file.mediaType?.startsWith("video/");
  const isPdf = file.mediaType === "application/pdf";

  return (
    <div className="max-w-sm">
      {isImage && (
        <img
          src={file.url}
          alt={file.filename || "Attached image"}
          className="max-w-full max-h-64 rounded-lg object-contain"
        />
      )}
      {isVideo && (
        <video
          src={file.url}
          controls
          className="max-w-full max-h-64 rounded-lg"
        >
          <track kind="captions" />
        </video>
      )}
      {isPdf && (
        <div className="flex items-center gap-2 text-sm rounded-lg border bg-muted/50 p-2">
          <svg
            className="h-6 w-6 text-red-500"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <title>PDF Document</title>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zm-3 9h2v2H10v-2zm0 3h2v2H10v-2zm-3-3h2v2H7v-2zm0 3h2v2H7v-2z" />
          </svg>
          <span className="font-medium truncate">
            {file.filename || "PDF Document"}
          </span>
        </div>
      )}
      {!isImage && !isVideo && !isPdf && (
        <div className="flex items-center gap-2 text-sm rounded-lg border bg-muted/50 p-2">
          <svg
            className="h-5 w-5 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <title>File Attachment</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
            />
          </svg>
          <span className="truncate">{file.filename || "Attached file"}</span>
        </div>
      )}
    </div>
  );
}

export function DebugDataPart({ part }: { part: { type: string } }) {
  return (
    <details className="not-prose rounded-md border bg-muted/30 p-3 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        {part.type}
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2">
        {JSON.stringify(part, null, 2)}
      </pre>
    </details>
  );
}

export function isHiddenChatPart(part: { type: string }): boolean {
  return (
    part.type === "step-start" ||
    part.type === "data-heartbeat" ||
    part.type === "data-token-usage" ||
    part.type === "source-url" ||
    part.type === "source-document"
  );
}

export function isUnknownDataPart(part: { type: string }): boolean {
  return part.type.startsWith("data-");
}
