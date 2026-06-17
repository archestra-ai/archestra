"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { Badge } from "@/components/ui/badge";
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
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type AgentSelectorAgent = {
  id: string;
  name: string;
  agentType: "agent" | "mcp_gateway" | "llm_proxy" | "profile";
  icon?: string | null;
  scope?: "personal" | "team" | "org";
  authorName?: string | null;
  authorEmail?: string | null;
  teams?: Array<{ name: string }>;
};

type AgentSelectorProps =
  | {
      mode: "single";
      agents: AgentSelectorAgent[];
      value: string;
      onValueChange: (value: string) => void;
      placeholder?: string;
      searchPlaceholder?: string;
      emptyMessage?: string;
      disabled?: boolean;
      className?: string;
      hint?: string;
      /**
       * Render every agent in one ungrouped list regardless of `agentType`,
       * instead of the default "Agents"/"MCP Gateways" group headings. Use this
       * for single-purpose pickers (e.g. an LLM-proxy or MCP-gateway dropdown)
       * whose items are all one conceptual kind but may carry mixed
       * `agentType`s (`profile`/`llm_proxy`/`mcp_gateway`).
       */
      flat?: boolean;
      personalDefaultOption?: {
        value: string;
        label: string;
      };
    }
  | {
      mode: "multiple";
      agents: AgentSelectorAgent[];
      value: string[];
      onValueChange: (value: string[]) => void;
      placeholder?: string;
      searchPlaceholder?: string;
      emptyMessage?: string;
      disabled?: boolean;
      disabledLabel?: string;
      className?: string;
      /**
       * Render every agent in one ungrouped list regardless of `agentType`,
       * instead of the default "Agents"/"MCP Gateways" group headings. Use this
       * for single-purpose multi-pickers (e.g. an MCP-gateway or LLM-proxy
       * allow-list) whose items are all one conceptual kind but may carry mixed
       * `agentType`s (`profile`/`llm_proxy`/`mcp_gateway`). Without it,
       * `llm_proxy` agents are not rendered.
       */
      flat?: boolean;
      allOption?: {
        label: string;
      };
    };

export function AgentSelector(props: AgentSelectorProps) {
  return props.mode === "single" ? (
    <SingleAgentSelector {...props} />
  ) : (
    <MultiAgentSelector {...props} />
  );
}

function SingleAgentSelector({
  agents,
  value,
  onValueChange,
  placeholder = "Select agent...",
  searchPlaceholder = "Search agents...",
  emptyMessage = "No agents found.",
  disabled,
  className,
  hint,
  flat,
  personalDefaultOption,
}: Extract<AgentSelectorProps, { mode: "single" }>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedAgent = agents.find((agent) => agent.id === value);
  const isPersonalDefaultSelected = personalDefaultOption?.value === value;
  const groupedAgents = useGroupedAgents(agents, search);
  const visibleAgents = useVisibleAgents(agents, search);

  const handleSelect = (agentId: string) => {
    onValueChange(agentId);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      open={disabled ? false : open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSearch("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            // h-auto + min-h-9 so a two-line row (name + owner email) isn't
            // vertically smushed, while single-line values keep the 9-height.
            "h-auto min-h-9 justify-between bg-transparent py-1.5 font-normal shadow-xs hover:bg-transparent hover:text-foreground",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedAgent ? (
              <AgentSelectorRow agent={selectedAgent} />
            ) : isPersonalDefaultSelected ? (
              personalDefaultOption.label
            ) : (
              placeholder
            )}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
          />
          {hint && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {hint}
            </div>
          )}
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {personalDefaultOption &&
              matchesSearch(personalDefaultOption.label, search) && (
                <CommandGroup>
                  <CommandItem
                    value={personalDefaultOption.value}
                    onSelect={() => handleSelect(personalDefaultOption.value)}
                    className="justify-between"
                  >
                    <span>{personalDefaultOption.label}</span>
                    <Check
                      className={cn(
                        "h-4 w-4",
                        isPersonalDefaultSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                </CommandGroup>
              )}
            {flat ? (
              <CommandGroup>
                {visibleAgents.map((agent) => (
                  <AgentSelectorItem
                    key={agent.id}
                    agent={agent}
                    selected={agent.id === value}
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            ) : (
              <AgentSelectorGroups
                groupedAgents={groupedAgents}
                selectedIds={[value]}
                onSelect={handleSelect}
              />
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function MultiAgentSelector({
  agents,
  value,
  onValueChange,
  placeholder = "Search agents and MCP gateways...",
  searchPlaceholder = "Search agents and MCP gateways...",
  emptyMessage = "No agents or MCP gateways found.",
  disabled,
  disabledLabel,
  className,
  flat,
  allOption,
}: Extract<AgentSelectorProps, { mode: "multiple" }>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedAgents = agents.filter((agent) => value.includes(agent.id));
  const groupedAgents = useGroupedAgents(agents, search);
  const visibleAgents = useVisibleAgents(agents, search);
  const allAgentIds = agents.map((agent) => agent.id);
  const allSelected =
    !!allOption &&
    allAgentIds.length > 0 &&
    allAgentIds.every((agentId) => value.includes(agentId));

  const handleSelect = (agentId: string) => {
    if (allSelected) {
      onValueChange([agentId]);
      setSearch("");
      return;
    }

    onValueChange(
      value.includes(agentId)
        ? value.filter((selectedId) => selectedId !== agentId)
        : [...value, agentId],
    );
    setSearch("");
  };

  const handleSelectAll = () => {
    onValueChange(allSelected ? [] : allAgentIds);
    setSearch("");
  };

  return (
    <Popover open={disabled ? false : open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          role="combobox"
          aria-expanded={open}
          aria-disabled={disabled}
          tabIndex={disabled ? undefined : -1}
          className={cn(
            "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
            disabled && "cursor-not-allowed opacity-60",
            className,
          )}
          onClick={() => {
            if (!disabled) setOpen(true);
          }}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === "Enter" || event.key === " ") {
              setOpen(true);
            }
          }}
        >
          {disabled && disabledLabel ? (
            <span className="text-muted-foreground">{disabledLabel}</span>
          ) : allSelected && allOption ? (
            <span>{allOption.label}</span>
          ) : selectedAgents.length === 0 ? (
            <span className="text-muted-foreground">{placeholder}</span>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {selectedAgents.map((agent) => (
                <Badge
                  key={agent.id}
                  variant="secondary"
                  className="max-w-[220px] gap-1"
                >
                  <span className="truncate">{agent.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${agent.name}`}
                    className="h-4 w-4 rounded-sm p-0 hover:bg-muted-foreground/20"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSelect(agent.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </Badge>
              ))}
            </div>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
          />
          <CommandList
            className="max-h-[260px] overflow-y-auto"
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {flat ? (
              <>
                {allOption &&
                  allAgentIds.length > 0 &&
                  matchesSearch(allOption.label, search) && (
                    <CommandGroup>
                      <CommandItem
                        value={allOption.label}
                        onSelect={handleSelectAll}
                        className="justify-between"
                      >
                        <span>{allOption.label}</span>
                        <Check
                          className={cn(
                            "h-4 w-4",
                            allSelected ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </CommandItem>
                    </CommandGroup>
                  )}
                <CommandGroup>
                  {visibleAgents.map((agent) => (
                    <AgentSelectorItem
                      key={agent.id}
                      agent={agent}
                      selected={allSelected ? false : value.includes(agent.id)}
                      onSelect={handleSelect}
                    />
                  ))}
                </CommandGroup>
              </>
            ) : (
              <AgentSelectorGroups
                allOption={
                  allOption &&
                  allAgentIds.length > 0 &&
                  matchesSearch(allOption.label, search)
                    ? {
                        label: allOption.label,
                        selected: allSelected,
                        onSelect: handleSelectAll,
                      }
                    : undefined
                }
                groupedAgents={groupedAgents}
                selectedIds={allSelected ? [] : value}
                onSelect={handleSelect}
              />
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AgentSelectorGroups({
  allOption,
  groupedAgents,
  selectedIds,
  onSelect,
}: {
  allOption?: {
    label: string;
    selected: boolean;
    onSelect: () => void;
  };
  groupedAgents: ReturnType<typeof useGroupedAgents>;
  selectedIds: string[];
  onSelect: (agentId: string) => void;
}) {
  return (
    <>
      {allOption && (
        <CommandGroup>
          <CommandItem
            value={allOption.label}
            onSelect={allOption.onSelect}
            className="justify-between"
          >
            <span>{allOption.label}</span>
            <Check
              className={cn(
                "h-4 w-4",
                allOption.selected ? "opacity-100" : "opacity-0",
              )}
            />
          </CommandItem>
        </CommandGroup>
      )}
      {groupedAgents.agents.length > 0 && (
        <CommandGroup heading="Agents">
          {groupedAgents.agents.map((agent) => (
            <AgentSelectorItem
              key={agent.id}
              agent={agent}
              selected={selectedIds.includes(agent.id)}
              onSelect={onSelect}
            />
          ))}
        </CommandGroup>
      )}
      {groupedAgents.gateways.length > 0 && (
        <CommandGroup heading="MCP Gateways">
          {groupedAgents.gateways.map((agent) => (
            <AgentSelectorItem
              key={agent.id}
              agent={agent}
              selected={selectedIds.includes(agent.id)}
              onSelect={onSelect}
            />
          ))}
        </CommandGroup>
      )}
    </>
  );
}

function AgentSelectorItem({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSelectorAgent;
  selected: boolean;
  onSelect: (agentId: string) => void;
}) {
  return (
    <CommandItem
      value={agent.id}
      onSelect={() => onSelect(agent.id)}
      className="justify-between"
    >
      <AgentSelectorRow agent={agent} />
      <Check
        className={cn("h-4 w-4", selected ? "opacity-100" : "opacity-0")}
      />
    </CommandItem>
  );
}

function AgentSelectorRow({ agent }: { agent: AgentSelectorAgent }) {
  const owner = getOwnerLabel(agent);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentIcon
        icon={agent.icon}
        fallbackType={agent.agentType === "profile" ? "agent" : agent.agentType}
        className="text-muted-foreground"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{agent.name}</span>
        {owner && (
          <span className="block truncate text-xs text-muted-foreground">
            {owner}
          </span>
        )}
      </span>
    </span>
  );
}

function useVisibleAgents(agents: AgentSelectorAgent[], search: string) {
  return useMemo(
    () =>
      agents.filter((agent) => matchesSearch(agentSearchText(agent), search)),
    [agents, search],
  );
}

function useGroupedAgents(agents: AgentSelectorAgent[], search: string) {
  return useMemo(() => {
    const visibleAgents = agents.filter((agent) =>
      matchesSearch(agentSearchText(agent), search),
    );

    return {
      agents: visibleAgents.filter((agent) => agent.agentType === "agent"),
      gateways: visibleAgents.filter(
        (agent) => agent.agentType === "mcp_gateway",
      ),
    };
  }, [agents, search]);
}

function agentSearchText(agent: AgentSelectorAgent) {
  return [agent.name, agent.authorEmail, agent.authorName]
    .concat((agent.teams ?? []).map((team) => team.name))
    .filter(Boolean)
    .join(" ");
}

function getOwnerLabel(agent: AgentSelectorAgent) {
  if (agent.scope !== "personal") {
    if (agent.scope === "team" && agent.teams?.length) {
      return agent.teams.map((team) => team.name).join(", ");
    }

    return null;
  }

  return agent.authorEmail ?? agent.authorName ?? "Personal";
}

function matchesSearch(value: string, search: string) {
  return !search || value.toLowerCase().includes(search.toLowerCase());
}
