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
import { useInternalAgents } from "@/lib/agent.query";
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
  const { data: agents = [] } = useInternalAgents();
  const [open, setOpen] = useState(false);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === currentPromptId) ?? agents[0] ?? null,
    [agents, currentPromptId],
  );

  const handleAgentSelect = (agentId: string | null) => {
    // For internal agents, the agent ID is both the "prompt ID" and agent ID
    onPromptChange(agentId, agentId ?? defaultAgentId);
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
            {currentAgent?.name ?? "Select agent"}
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
              {agents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={agent.name}
                  onSelect={() => handleAgentSelect(agent.id)}
                >
                  {agent.name}
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      currentPromptId === agent.id
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
