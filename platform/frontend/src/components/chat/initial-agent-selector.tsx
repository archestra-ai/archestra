"use client";

import { Check, Search, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInternalAgents } from "@/lib/agent.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { cn } from "@/lib/utils";

type ScopeFilter = "all" | "personal" | "team" | "org";

interface InitialAgentSelectorProps {
  currentAgentId: string | null;
  onAgentChange: (agentId: string) => void;
}

export function InitialAgentSelector({
  currentAgentId,
  onAgentChange,
}: InitialAgentSelectorProps) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");

  // Filter out other users' personal agents
  const agents = useMemo(() => {
    const userId = session?.user?.id;
    return allAgents.filter(
      (a) =>
        (a as unknown as Record<string, unknown>).scope !== "personal" ||
        (a as unknown as Record<string, unknown>).authorId === userId,
    );
  }, [allAgents, session?.user?.id]);

  const filteredAgents = useMemo(() => {
    let result = agents;

    // Apply scope filter
    if (scopeFilter !== "all") {
      result = result.filter(
        (a) => (a as unknown as Record<string, unknown>).scope === scopeFilter,
      );
    }

    // Apply search filter
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(lower) ||
          a.description?.toLowerCase().includes(lower),
      );
    }

    return result;
  }, [agents, search, scopeFilter]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === currentAgentId) ?? agents[0] ?? null,
    [agents, currentAgentId],
  );

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setOpen(false);
    setSearch("");
    setScopeFilter("all");
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setSearch("");
      setScopeFilter("all");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <PromptInputButton
          role="combobox"
          aria-expanded={open}
          data-agent-selector
          className="max-w-[300px] min-w-0"
        >
          <AgentIcon
            icon={
              (currentAgent as unknown as Record<string, unknown>)?.icon as
                | string
                | null
            }
            size={16}
          />
          <span className="truncate flex-1 text-left">
            {currentAgent?.name ?? "Select agent"}
          </span>
        </PromptInputButton>
      </DialogTrigger>
      <DialogContent
        className="max-w-3xl p-0 gap-0"
        onCloseAutoFocus={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Select Agent</DialogTitle>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Select
            value={scopeFilter}
            onValueChange={(v) => setScopeFilter(v as ScopeFilter)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom" align="start">
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="personal">Personal</SelectItem>
              <SelectItem value="team">Team</SelectItem>
              <SelectItem value="org">Organization</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex-1" />
          <DialogClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
        <div className="px-4 pt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>
        <div className="px-4 pt-4 pb-4 max-h-[500px] overflow-y-auto">
          {filteredAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No agents found.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {filteredAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isSelected={currentAgentId === agent.id}
                  onSelect={() => handleAgentSelect(agent.id)}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentCard({
  agent,
  isSelected,
  onSelect,
}: {
  agent: {
    id: string;
    name: string;
    description?: string | null;
    scope: string;
  };
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-full flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer",
        isSelected && "border-primary bg-accent",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <AgentIcon
            icon={
              (agent as unknown as Record<string, unknown>).icon as
                | string
                | null
            }
            size={16}
          />
        </div>
        <span className="text-sm font-medium truncate flex-1">
          {agent.name}
        </span>
        {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
      </div>
      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 w-full">
          {agent.description}
        </p>
      )}
      <div className="flex items-center gap-2 w-full mt-auto">
        <AgentBadge
          type={agent.scope as "personal" | "team" | "org"}
          className="text-[10px] px-1.5 py-0"
        />
      </div>
    </button>
  );
}
