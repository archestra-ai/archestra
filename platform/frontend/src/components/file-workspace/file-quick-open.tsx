"use client";

import type { ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** One file the palette offers. */
export interface QuickOpenItem {
  key: string;
  /** What a search matches against: name, path, and any status worth finding. */
  search: string;
  icon: ReactNode;
  label: ReactNode;
  /** The path, beside the label. */
  detail?: string;
  trailing?: ReactNode;
  disabled?: boolean;
}

export interface QuickOpenConfig {
  /** The dialog's accessible title, such as "Open a policy file". */
  title: string;
  description: string;
  groups: { heading?: string; items: QuickOpenItem[] }[];
  onSelect: (key: string) => void;
}

/** A searchable palette of a workspace's files, opened with Cmd/Ctrl+P. */
export function FileQuickOpen({
  config,
  open,
  onOpenChange,
}: {
  config: QuickOpenConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const groups = config.groups.filter((group) => group.items.length > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Go to file" />
          <CommandList className="max-h-[min(60vh,440px)]">
            <CommandEmpty>No file matches.</CommandEmpty>
            {groups.map((group, index) => (
              <CommandGroup
                key={group.heading ?? index}
                heading={group.heading}
              >
                {group.items.map((item) => (
                  <CommandItem
                    key={item.key}
                    value={`${item.key} ${item.search}`}
                    disabled={item.disabled}
                    onSelect={() => {
                      config.onSelect(item.key);
                      onOpenChange(false);
                    }}
                    className="h-7 gap-2 py-0 text-[13px]"
                  >
                    {item.icon}
                    <span className="shrink-0">{item.label}</span>
                    {item.detail && (
                      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                        {item.detail}
                      </span>
                    )}
                    {item.trailing && (
                      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        {item.trailing}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
