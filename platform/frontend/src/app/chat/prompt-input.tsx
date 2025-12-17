"use client";

import type { ChatStatus } from "ai";
import { AtSignIcon, FilesIcon, GlobeIcon, RulerIcon } from "lucide-react";
import { type FormEvent, useRef } from "react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandInput,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputCommandSeparator,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputHoverCard,
  PromptInputHoverCardContent,
  PromptInputHoverCardTrigger,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTab,
  PromptInputTabBody,
  PromptInputTabItem,
  PromptInputTabLabel,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ModelSelector } from "@/components/chat/model-selector";

const sampleFiles = {
  activeTabs: [{ path: "prompt-input.tsx", location: "packages/elements/src" }],
  recents: [
    { path: "queue.tsx", location: "apps/test/app/examples" },
    { path: "queue.tsx", location: "packages/elements/src" },
  ],
  added: [
    { path: "prompt-input.tsx", location: "packages/elements/src" },
    { path: "queue.tsx", location: "apps/test/app/examples" },
    { path: "queue.tsx", location: "packages/elements/src" },
  ],
  filesAndFolders: [
    { path: "prompt-input.tsx", location: "packages/elements/src" },
    { path: "queue.tsx", location: "apps/test/app/examples" },
  ],
  code: [{ path: "prompt-input.tsx", location: "packages/elements/src" }],
  docs: [{ path: "README.md", location: "packages/elements" }],
};

const sampleTabs = {
  active: [{ path: "packages/elements/src/task-queue-panel.tsx" }],
  recents: [
    { path: "apps/test/app/examples/task-queue-panel.tsx" },
    { path: "apps/test/app/page.tsx" },
    { path: "packages/elements/src/task.tsx" },
    { path: "apps/test/app/examples/prompt-input.tsx" },
    { path: "packages/elements/src/queue.tsx" },
    { path: "apps/test/app/examples/queue.tsx" },
  ],
};

const ArchestraPromptInput = ({
  onSubmit,
  status,
  selectedModel,
  onModelChange,
  messageCount = 0,
}: {
  onSubmit: (
    message: PromptInputMessage,
    e: FormEvent<HTMLFormElement>,
  ) => void;
  status: ChatStatus;
  selectedModel: string;
  onModelChange: (model: string) => void;
  messageCount?: number;
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex size-full flex-col justify-end">
      <PromptInputProvider>
        <PromptInput globalDrop multiple onSubmit={onSubmit}>
          <PromptInputHeader>
            <PromptInputHoverCard>
              <PromptInputHoverCardTrigger>
                <PromptInputButton
                  className="!h-8"
                  size="icon-sm"
                  variant="outline"
                >
                  <AtSignIcon className="text-muted-foreground" size={12} />
                </PromptInputButton>
              </PromptInputHoverCardTrigger>
              <PromptInputHoverCardContent className="w-[400px] p-0">
                <PromptInputCommand>
                  <PromptInputCommandInput
                    className="border-none focus-visible:ring-0"
                    placeholder="Add files, folders, docs..."
                  />
                  <PromptInputCommandList>
                    <PromptInputCommandEmpty className="p-3 text-muted-foreground text-sm">
                      No results found.
                    </PromptInputCommandEmpty>
                    <PromptInputCommandGroup heading="Added">
                      <PromptInputCommandItem>
                        <GlobeIcon />
                        <span>Active Tabs</span>
                        <span className="ml-auto text-muted-foreground">✓</span>
                      </PromptInputCommandItem>
                    </PromptInputCommandGroup>
                    <PromptInputCommandSeparator />
                    <PromptInputCommandGroup heading="Other Files">
                      {sampleFiles.added.map((file, index) => (
                        <PromptInputCommandItem key={`${file.path}-${index}`}>
                          <GlobeIcon className="text-primary" />
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">
                              {file.path}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {file.location}
                            </span>
                          </div>
                        </PromptInputCommandItem>
                      ))}
                    </PromptInputCommandGroup>
                  </PromptInputCommandList>
                </PromptInputCommand>
              </PromptInputHoverCardContent>
            </PromptInputHoverCard>
            <PromptInputHoverCard>
              <PromptInputHoverCardTrigger>
                <PromptInputButton size="sm" variant="outline">
                  <RulerIcon className="text-muted-foreground" size={12} />
                  <span>1</span>
                </PromptInputButton>
              </PromptInputHoverCardTrigger>
              <PromptInputHoverCardContent className="divide-y overflow-hidden p-0">
                <div className="space-y-2 p-3">
                  <p className="font-medium text-muted-foreground text-sm">
                    Attached Project Rules
                  </p>
                  <p className="ml-4 text-muted-foreground text-sm">
                    Always Apply:
                  </p>
                  <p className="ml-8 text-sm">ultracite.mdc</p>
                </div>
                <p className="bg-sidebar px-4 py-3 text-muted-foreground text-sm">
                  Click to manage
                </p>
              </PromptInputHoverCardContent>
            </PromptInputHoverCard>
            <PromptInputHoverCard>
              <PromptInputHoverCardTrigger>
                <PromptInputButton size="sm" variant="outline">
                  <FilesIcon className="text-muted-foreground" size={12} />
                  <span>1 Tab</span>
                </PromptInputButton>
              </PromptInputHoverCardTrigger>
              <PromptInputHoverCardContent className="w-[300px] space-y-4 px-0 py-3">
                <PromptInputTab>
                  <PromptInputTabLabel>Active Tabs</PromptInputTabLabel>
                  <PromptInputTabBody>
                    {sampleTabs.active.map((tab) => (
                      <PromptInputTabItem key={tab.path}>
                        <GlobeIcon className="text-primary" size={16} />
                        <span className="truncate" dir="rtl">
                          {tab.path}
                        </span>
                      </PromptInputTabItem>
                    ))}
                  </PromptInputTabBody>
                </PromptInputTab>
                <PromptInputTab>
                  <PromptInputTabLabel>Recents</PromptInputTabLabel>
                  <PromptInputTabBody>
                    {sampleTabs.recents.map((tab) => (
                      <PromptInputTabItem key={tab.path}>
                        <GlobeIcon className="text-primary" size={16} />
                        <span className="truncate" dir="rtl">
                          {tab.path}
                        </span>
                      </PromptInputTabItem>
                    ))}
                  </PromptInputTabBody>
                </PromptInputTab>
                <div className="border-t px-3 pt-2 text-muted-foreground text-xs">
                  Only file paths are included
                </div>
              </PromptInputHoverCardContent>
            </PromptInputHoverCard>
            <PromptInputAttachments>
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
          </PromptInputHeader>
          <PromptInputBody>
            <PromptInputTextarea
              placeholder="Plan, search, build anything"
              ref={textareaRef}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <ModelSelector
                selectedModel={selectedModel}
                onModelChange={onModelChange}
                messageCount={messageCount}
              />
            </PromptInputTools>
            <div className="flex items-center gap-2">
              {/* <PromptInputSpeechButton textareaRef={textareaRef} /> fix & enable */}
              <PromptInputSubmit className="!h-8" status={status} />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
};

export default ArchestraPromptInput;
