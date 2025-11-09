import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgents } from "@/lib/agent.query";

interface AgentSelectorProps {
  onSelectAgent: (agentId: string) => void;
  disabled?: boolean;
}

export function AgentSelector({
  onSelectAgent,
  disabled = false,
}: AgentSelectorProps) {
  const { data: agents, isLoading } = useAgents();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled || isLoading} className="w-full">
          New Chat
          <ChevronDown className="ml-2 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start">
        {isLoading ? (
          <DropdownMenuItem disabled>Loading agents...</DropdownMenuItem>
        ) : agents && agents.length > 0 ? (
          agents.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onClick={() => onSelectAgent(agent.id)}
              className="flex items-center justify-between"
            >
              <span className="truncate">{agent.name}</span>
              <Badge variant="secondary" className="ml-2 text-xs">
                {agent.tools?.length || 0} tools
              </Badge>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>No agents available</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
