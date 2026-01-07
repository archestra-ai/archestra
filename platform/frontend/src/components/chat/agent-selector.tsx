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
import { useCreateConversation } from "@/lib/chat.query";
import { usePrompts } from "@/lib/prompts.query";
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
  const { data: prompts = [] } = usePrompts();
  const createConversationMutation = useCreateConversation();
  const [open, setOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<{
    id: string | null;
    name: string;
    agentId: string;
  } | null>(null);

  const currentPrompt = useMemo(
    () => prompts.find((p) => p.id === currentPromptId),
    [prompts, currentPromptId],
  );

  const handlePromptSelect = (
    newPromptId: string | null,
    promptName: string,
    agentId: string,
  ) => {
    if (newPromptId === currentPromptId) {
      setOpen(false);
      return;
    }

    // Show confirmation dialog
    setPendingPrompt({ id: newPromptId, name: promptName, agentId });
    setOpen(false);
  };

  const handleConfirm = async () => {
    if (!pendingPrompt) return;

    // Create a new conversation with the selected agent
    const newConversation = await createConversationMutation.mutateAsync({
      agentId: pendingPrompt.agentId,
      promptId: pendingPrompt.id ?? undefined,
      selectedModel: currentModel,
    });

    if (newConversation) {
      router.push(`/chat?conversation=${newConversation.id}`);
    }

    setPendingPrompt(null);
  };

  return (
    <>
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
                  onSelect={() =>
                    handlePromptSelect(
                      null,
                      "No agent selected",
                      currentAgentId,
                    )
                  }
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
                    onSelect={() =>
                      handlePromptSelect(prompt.id, prompt.name, prompt.agentId)
                    }
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

      <AlertDialog
        open={!!pendingPrompt}
        onOpenChange={(open) => !open && setPendingPrompt(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start new conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will start a new conversation with{" "}
              <span className="font-medium">{pendingPrompt?.name}</span>. Your
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
