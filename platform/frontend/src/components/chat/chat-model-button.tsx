"use client";

import { E2eTestId } from "@archestra/shared";
import { useState } from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  ChatSetupMenu,
  type ChatSetupMenuProps,
} from "@/components/chat/chat-setup-menu";
import { useChatSetupMenuPosition } from "@/components/chat/use-chat-setup-menu-position";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  REASONING_OPTIONS,
  useChatSetupOptions,
} from "@/lib/chat/use-chat-setup-options";
import { logoNameForProvider } from "@/lib/provider-logos";

/**
 * A new chat's model control: the model's name, plus the reasoning level when
 * one is chosen, opening the setup menu's Model and Key tabs. It also keeps
 * the selected model valid as the key changes, so it stays mounted.
 */
export function ChatModelButton({
  onOpenChange,
  ...menuProps
}: Omit<ChatSetupMenuProps, "close" | "onAgentChange"> & {
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const { triggerRef, position, updatePosition } =
    useChatSetupMenuPosition(open);
  const setOpen = (next: boolean) => {
    if (next) updatePosition();
    setOpenState(next);
    onOpenChange?.(next);
  };
  const data = useChatSetupOptions({ ...menuProps, agentSearch: "" });
  const provider = data.activeModel?.provider ?? menuProps.currentProvider;
  // Auto is the default and needs no label; only a chosen level shows.
  const level =
    data.supportsReasoning && menuProps.thinkingEffort !== null
      ? REASONING_OPTIONS.find(
          (option) => option.value === menuProps.thinkingEffort,
        )
      : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            data.supportsReasoning
              ? `Model: ${data.modelName}, reasoning ${level?.label ?? "Auto"}`
              : `Model: ${data.modelName}`
          }
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
          data-testid={E2eTestId.ChatModelSelectorTrigger}
          className="h-8 min-w-0 max-w-72 gap-1.5 px-2 font-normal"
        >
          {provider && (
            <ModelSelectorLogo
              provider={logoNameForProvider(provider)}
              className="size-4 shrink-0"
            />
          )}
          {menuProps.subscriptionConnectRequired ? (
            <span className="truncate text-primary">
              {menuProps.subscriptionSignInTitle}
            </span>
          ) : (
            <span className="truncate">{data.modelName}</span>
          )}
          {level && !menuProps.subscriptionConnectRequired && (
            <span
              aria-hidden
              className="shrink-0 text-muted-foreground text-xs"
            >
              <span className="px-0.5 text-muted-foreground/60">·</span>
              {level.label}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side={position.side}
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-auto overflow-hidden rounded-xl p-0"
      >
        <ChatSetupMenu
          {...menuProps}
          maxHeight={position.maxHeight}
          close={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
