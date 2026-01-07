"use client";

import { Bot, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { usePrompts } from "@/lib/prompts.query";
import { cn } from "@/lib/utils";

interface InitialAgentSelectorProps {
  currentPromptId: string | null;
  onPromptChange: (promptId: string | null, agentId: string) => void;
  defaultAgentId: string;
}

export function InitialAgentSelector({
  currentPromptId,
  onPromptChange,
  defaultAgentId,
}: InitialAgentSelectorProps) {
  const { data: prompts = [] } = usePrompts();
  const [open, setOpen] = useState(false);

  const currentPrompt = useMemo(
    () => prompts.find((p) => p.id === currentPromptId),
    [prompts, currentPromptId],
  );

  const handlePromptSelect = (promptId: string | null, agentId: string) => {
    onPromptChange(promptId, agentId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 justify-between"
        >
          <Bot className="h-3 w-3 shrink-0 opacity-70" />
          <span className="text-xs font-medium">
            {currentPrompt?.name || "No agent selected"}
          </span>
          {open ? (
            <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
          ) : (
            <ChevronRight className="ml-1 h-3 w-3 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search agent..." className="h-9" />
          <CommandList>
            <CommandEmpty>No agent found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="no-agent-selected"
                onSelect={() => handlePromptSelect(null, defaultAgentId)}
              >
                No agent selected
                <Check
                  className={cn(
                    "ml-auto h-4 w-4",
                    currentPromptId === null ? "opacity-100" : "opacity-0",
                  )}
                />
              </CommandItem>
              {prompts.map((prompt) => (
                <CommandItem
                  key={prompt.id}
                  value={prompt.name}
                  onSelect={() => handlePromptSelect(prompt.id, prompt.agentId)}
                >
                  {prompt.name}
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      currentPromptId === prompt.id
                        ? "opacity-100"
                        : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
