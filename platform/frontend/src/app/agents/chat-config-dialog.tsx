"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAgentPrompts,
  useAssignAgentPrompts,
} from "@/lib/agent-prompts.query";
import { usePrompts } from "@/lib/prompts.query";

interface ChatConfigDialogProps {
  agent: archestraApiTypes.GetAllAgentsResponses["200"][number];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ChatConfigDialogContent({
  agent,
  open,
  onOpenChange,
}: ChatConfigDialogProps) {
  const { data: systemPrompts } = usePrompts({ type: "system" });
  const { data: regularPrompts } = usePrompts({ type: "regular" });
  const { data: agentPrompts } = useAgentPrompts(agent.id);
  const assignPrompts = useAssignAgentPrompts();

  const [selectedSystemPromptId, setSelectedSystemPromptId] = useState<
    string | undefined
  >();
  const [selectedRegularPromptIds, setSelectedRegularPromptIds] = useState<
    string[]
  >([]);

  // Initialize selected prompts when dialog opens
  useEffect(() => {
    if (open && agentPrompts) {
      const systemPrompt = agentPrompts.find(
        (ap) => ap.prompt.type === "system",
      );
      const regularPromptsList = agentPrompts.filter(
        (ap) => ap.prompt.type === "regular",
      );

      setSelectedSystemPromptId(systemPrompt?.promptId);
      setSelectedRegularPromptIds(regularPromptsList.map((ap) => ap.promptId));
    }
  }, [open, agentPrompts]);

  const handleSave = async () => {
    try {
      await assignPrompts.mutateAsync({
        agentId: agent.id,
        data: {
          systemPromptId: selectedSystemPromptId || null,
          regularPromptIds: selectedRegularPromptIds,
        },
      });
      toast.success("Agent prompts updated successfully");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to update agent prompts");
    }
  };

  const toggleRegularPrompt = (promptId: string) => {
    setSelectedRegularPromptIds((prev) =>
      prev.includes(promptId)
        ? prev.filter((id) => id !== promptId)
        : [...prev, promptId],
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configure Chat Prompts</DialogTitle>
          <DialogDescription>Assign prompts to {agent.name}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          {/* System Prompt Selection */}
          <div className="space-y-2">
            <Label htmlFor="systemPrompt">System Prompt (Optional)</Label>
            <Select
              value={selectedSystemPromptId || "none"}
              onValueChange={(value) =>
                setSelectedSystemPromptId(value === "none" ? undefined : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select system prompt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {systemPrompts?.map((prompt) => (
                  <SelectItem key={prompt.id} value={prompt.id}>
                    {prompt.name} (v{prompt.version})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Regular Prompts Selection */}
          <div className="space-y-2">
            <Label>Regular Prompts (Optional)</Label>
            {regularPrompts && regularPrompts.length > 0 ? (
              <div className="space-y-2 border rounded-md p-4 max-h-[300px] overflow-y-auto">
                {regularPrompts.map((prompt) => (
                  <div
                    key={prompt.id}
                    className="flex items-center space-x-2 p-2 hover:bg-accent rounded"
                  >
                    <Checkbox
                      id={prompt.id}
                      checked={selectedRegularPromptIds.includes(prompt.id)}
                      onCheckedChange={() => toggleRegularPrompt(prompt.id)}
                    />
                    <Label
                      htmlFor={prompt.id}
                      className="flex-1 cursor-pointer"
                    >
                      {prompt.name} (v{prompt.version})
                    </Label>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No regular prompts available. Create some in Chat Settings.
              </p>
            )}
            <Link
              href="/settings/chat"
              className="text-sm text-primary hover:underline inline-block"
            >
              Manage prompts in Chat Settings →
            </Link>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={assignPrompts.isPending}>
            {assignPrompts.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChatConfigDialog(props: ChatConfigDialogProps) {
  return (
    <Suspense
      fallback={
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
          <DialogContent>
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          </DialogContent>
        </Dialog>
      }
    >
      <ChatConfigDialogContent {...props} />
    </Suspense>
  );
}
