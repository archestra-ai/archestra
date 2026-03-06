"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
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
                    <AgentBadge
                      type={agent.scope}
                      className="text-[10px] px-1 py-0"
                    />
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
