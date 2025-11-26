"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAgents } from "@/lib/agent.query";
import { useCreatePrompt, useUpdatePrompt } from "@/lib/prompts.query";

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt?: Prompt | null;
  onViewVersionHistory?: (prompt: Prompt) => void;
}

export function PromptDialog({
  open,
  onOpenChange,
  prompt,
  onViewVersionHistory,
}: PromptDialogProps) {
  const { data: allAgents = [] } = useAgents();
  const agents = allAgents.filter((agent) => agent.useInChat);
  const createPrompt = useCreatePrompt();
  const updatePrompt = useUpdatePrompt();

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");

  // Reset form when dialog opens/closes or prompt changes
  useEffect(() => {
    if (open) {
      if (prompt) {
        setName(prompt.name);
        setAgentId(prompt.agentId);
        setUserPrompt(prompt.userPrompt || "");
        setSystemPrompt(prompt.systemPrompt || "");
      } else {
        setName("");
        setAgentId("");
        setUserPrompt("");
        setSystemPrompt("");
      }
    }
  }, [open, prompt]);

  const handleSave = async () => {
    if (!name || !agentId) {
      toast.error("Name and Profile are required");
      return;
    }

    if (!userPrompt && !systemPrompt) {
      toast.error("At least one prompt (User or System) is required");
      return;
    }

    try {
      if (prompt) {
        await updatePrompt.mutateAsync({
          id: prompt.id,
          data: {
            agentId,
            userPrompt: userPrompt || undefined,
            systemPrompt: systemPrompt || undefined,
          },
        });
        toast.success("New version created successfully");
      } else {
        await createPrompt.mutateAsync({
          name,
          agentId,
          userPrompt: userPrompt || undefined,
          systemPrompt: systemPrompt || undefined,
        });
        toast.success("Prompt created successfully");
      }
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to save prompt");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {prompt ? "Edit Prompt" : "Create New Prompt"}
            {prompt && onViewVersionHistory && (
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  onViewVersionHistory(prompt);
                }}
                className="text-xs h-auto p-0 ml-2"
              >
                Version History
              </Button>
            )}
          </DialogTitle>
          <DialogDescription>
            {prompt
              ? "This will create a new version of the prompt"
              : "Create a new prompt for a profile"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!prompt && (
            <div className="space-y-2">
              <Label htmlFor="promptName">Name *</Label>
              <Input
                id="promptName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter prompt name"
              />
            </div>
          )}
          {prompt && (
            <div className="space-y-2">
              <Label>Name</Label>
              <div className="text-sm font-medium">{prompt.name}</div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="agentId">Profile *</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a profile" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="systemPrompt">System Prompt</Label>
            <Textarea
              id="systemPrompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Enter system prompt (instructions for the LLM)"
              className="min-h-[150px] font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="userPrompt">User Prompt</Label>
            <Textarea
              id="userPrompt"
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              placeholder="Enter user prompt (shown to user, sent to LLM)"
              className="min-h-[150px] font-mono"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              !name ||
              !agentId ||
              (!userPrompt && !systemPrompt) ||
              createPrompt.isPending ||
              updatePrompt.isPending
            }
          >
            {(createPrompt.isPending || updatePrompt.isPending) && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {prompt ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
