"use client";

import { Bot, Check, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useInternalAgents } from "@/lib/agent.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { cn } from "@/lib/utils";

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
    if (!search) return agents;
    const lower = search.toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(lower) ||
        a.description?.toLowerCase().includes(lower),
    );
  }, [agents, search]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === currentAgentId) ?? agents[0] ?? null,
    [agents, currentAgentId],
  );

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setOpen(false);
    setSearch("");
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) setSearch("");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          data-agent-selector
          className="h-8 justify-between max-w-[300px] min-w-0"
        >
          <Bot className="h-3 w-3 shrink-0 opacity-70" />
          <span className="text-xs font-medium truncate flex-1 text-left">
            {currentAgent?.name ?? "Select agent"}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-2xl p-0 gap-0"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Select Agent</DialogTitle>
        <div className="p-4 pb-3">
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="px-4 pb-4 max-h-[400px] overflow-y-auto">
          {filteredAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No agents found.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
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
  const { data: tools = [] } = useChatProfileMcpTools(agent.id);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent cursor-pointer",
        isSelected && "border-primary bg-accent",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <span className="text-sm font-medium truncate flex-1">{agent.name}</span>
        {isSelected && (
          <Check className="h-4 w-4 shrink-0 text-primary" />
        )}
      </div>
      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 w-full">
          {agent.description}
        </p>
      )}
      <div className="flex items-center gap-2 w-full">
        <AgentBadge
          type={agent.scope}
          className="text-[10px] px-1.5 py-0"
        />
        {tools.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Wrench className="h-3 w-3" />
            <span>{tools.length}</span>
          </div>
        )}
      </div>
    </button>
  );
}
