"use client";

import { Bot, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useInternalAgents } from "@/lib/agent.query";
import { useCreateConversation } from "@/lib/chat.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { cn } from "@/lib/utils";

interface AgentSelectorProps {
  currentPromptId: string | null;
  currentAgentId: string;
  currentModel: string;
}

export function AgentSelector({
  currentPromptId,
  currentAgentId,
  currentModel,
}: AgentSelectorProps) {
  const router = useRouter();
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const createConversationMutation = useCreateConversation();

  // Filter out other users' personal agents
  const agents = useMemo(() => {
    const userId = session?.user?.id;
    return allAgents.filter(
      (a) =>
        (a as unknown as Record<string, unknown>).scope !== "personal" ||
        (a as unknown as Record<string, unknown>).authorId === userId,
    );
  }, [allAgents, session?.user?.id]);
  const [open, setOpen] = useState(false);
  const [pendingAgent, setPendingAgent] = useState<{
    id: string | null;
    name: string;
  } | null>(null);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === currentPromptId) ?? agents[0] ?? null,
    [agents, currentPromptId],
  );

  const handleAgentSelect = (newAgentId: string | null, agentName: string) => {
    if (newAgentId === currentPromptId) {
      setOpen(false);
      return;
    }

    // Show confirmation dialog
    setPendingAgent({ id: newAgentId, name: agentName });
    setOpen(false);
  };

  const handleConfirm = async () => {
    if (!pendingAgent) return;

    // Create a new conversation with the selected agent
    // For internal agents, the agent ID is the agent itself (no separate prompt)
    const newConversation = await createConversationMutation.mutateAsync({
      agentId: pendingAgent.id ?? currentAgentId,
      selectedModel: currentModel,
    });

    if (newConversation) {
      router.push(`/chat?conversation=${newConversation.id}`);
    }

    setPendingAgent(null);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            data-agent-selector
            className="h-8 justify-between max-w-[300px] min-w-0"
          >
            <Bot className="h-3 w-3 shrink-0 opacity-70" />
            <span className="text-xs font-medium truncate flex-1 text-left">
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
                    onSelect={() => handleAgentSelect(agent.id, agent.name)}
                  >
                    <span className="truncate">{agent.name}</span>
                    {(agent as unknown as Record<string, unknown>).scope ===
                    "personal" ? (
                      <Badge
                        variant="outline"
                        className="bg-blue-500/10 text-blue-600 border-blue-500/30 text-[10px] px-1 py-0 shrink-0"
                      >
                        Personal
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="bg-green-500/10 text-green-600 border-green-500/30 text-[10px] px-1 py-0 shrink-0"
                      >
                        Shared
                      </Badge>
                    )}
                    <Check
                      className={cn(
                        "ml-auto h-4 w-4 shrink-0",
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

      <AlertDialog
        open={!!pendingAgent}
        onOpenChange={(open) => !open && setPendingAgent(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start new conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will start a new conversation with{" "}
              <span className="font-medium">{pendingAgent?.name}</span>. Your
              current conversation will be saved and available in the sidebar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={createConversationMutation.isPending}
            >
              {createConversationMutation.isPending
                ? "Creating..."
                : "Start new conversation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
