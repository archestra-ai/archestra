"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChatToolsDisplay } from "@/components/chat/chat-tools-display";
import { ProfileSelector } from "@/components/chat/profile-selector";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Textarea } from "@/components/ui/textarea";
import { useProfiles } from "@/lib/agent.query";
import { useChatOpsStatus } from "@/lib/chatops.query";
import {
  usePromptAgents,
  useSyncPromptAgents,
} from "@/lib/prompt-agents.query";
import {
  useCreatePrompt,
  usePrompts,
  useUpdatePrompt,
} from "@/lib/prompts.query";

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
  const { data: allProfiles = [] } = useProfiles();
  const { data: allPrompts = [] } = usePrompts();
  const createPrompt = useCreatePrompt();
  const updatePrompt = useUpdatePrompt();
  const syncPromptAgents = useSyncPromptAgents();
  const { data: currentAgents = [] } = usePromptAgents(prompt?.id);

  const [name, setName] = useState("");
  const [agentId, setProfileId] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedAgentPromptIds, setSelectedAgentPromptIds] = useState<
    string[]
  >([]);
  const [allowedChatops, setAllowedChatops] = useState<string[]>([]);

  const { data: chatopsProviders = [] } = useChatOpsStatus();

  // Available prompts that can be used as agents (excluding self)
  const availableAgentPrompts = useMemo(() => {
    return allPrompts
      .filter((p) => p.id !== prompt?.id)
      .map((p) => {
        const profile = allProfiles.find((prof) => prof.id === p.agentId);
        return {
          value: p.id,
          label: profile ? `${p.name} (${profile.name})` : p.name,
        };
      });
  }, [allPrompts, allProfiles, prompt?.id]);

  // Reset form when dialog opens/closes or prompt changes
  useEffect(() => {
    if (open) {
      // edit
      if (prompt) {
        setName(prompt.name);
        setProfileId(prompt.agentId);
        setUserPrompt(prompt.userPrompt || "");
        setSystemPrompt(prompt.systemPrompt || "");
        // Note: agents are loaded separately via currentAgents query
        // Parse allowedChatops from prompt (may be in different formats from API)
        const chatopsValue = prompt.allowedChatops;
        if (Array.isArray(chatopsValue)) {
          setAllowedChatops(chatopsValue as string[]);
        } else {
          setAllowedChatops([]);
        }
      } else {
        // create
        setName("");
        setUserPrompt("");
        setSystemPrompt("");
        setSelectedAgentPromptIds([]);
        setAllowedChatops([]);
      }
    } else {
      // reset form
      setName("");
      setProfileId("");
      setUserPrompt("");
      setSystemPrompt("");
      setSelectedAgentPromptIds([]);
      setAllowedChatops([]);
    }
  }, [open, prompt]);

  // Sync selectedAgentPromptIds with currentAgents when data loads
  // Use a stable string representation to avoid infinite loops
  const currentAgentIds = currentAgents.map((a) => a.agentPromptId).join(",");
  const promptId = prompt?.id;

  useEffect(() => {
    if (open && promptId && currentAgentIds) {
      setSelectedAgentPromptIds(currentAgentIds.split(",").filter(Boolean));
    }
  }, [open, promptId, currentAgentIds]);

  useEffect(() => {
    if (open) {
      // if on create and no agentId, set the first agent
      if (!prompt && !agentId) {
        setProfileId(allProfiles[0].id);
      }
    }
  }, [open, prompt, allProfiles, agentId]);

  const handleSave = useCallback(async () => {
    // Trim values once at the start
    const trimmedName = name.trim();
    const trimmedUserPrompt = userPrompt.trim();
    const trimmedSystemPrompt = systemPrompt.trim();

    if (!trimmedName || !agentId) {
      toast.error("Name and Profile are required");
      return;
    }

    try {
      let promptId: string;

      if (prompt) {
        // Update increments version (ID stays the same with JSONB history)
        const updated = await updatePrompt.mutateAsync({
          id: prompt.id,
          data: {
            name: trimmedName,
            agentId,
            userPrompt: trimmedUserPrompt || undefined,
            systemPrompt: trimmedSystemPrompt || undefined,
            allowedChatops,
          },
        });
        promptId = updated?.id ?? prompt.id;
        toast.success("Agent updated successfully");
      } else {
        const created = await createPrompt.mutateAsync({
          name: trimmedName,
          agentId,
          userPrompt: trimmedUserPrompt || undefined,
          systemPrompt: trimmedSystemPrompt || undefined,
          allowedChatops,
        });
        promptId = created?.id ?? "";
        toast.success("Agent created successfully");
      }

      // Sync agents if any were selected and we have a valid promptId
      if (promptId && selectedAgentPromptIds.length > 0) {
        await syncPromptAgents.mutateAsync({
          promptId,
          agentPromptIds: selectedAgentPromptIds,
        });
      } else if (promptId && prompt && currentAgents.length > 0) {
        // Clear agents if none selected but there were some before
        await syncPromptAgents.mutateAsync({
          promptId,
          agentPromptIds: [],
        });
      }

      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to save Agent");
    }
  }, [
    name,
    agentId,
    userPrompt,
    systemPrompt,
    allowedChatops,
    prompt,
    selectedAgentPromptIds,
    currentAgents.length,
    updatePrompt,
    createPrompt,
    syncPromptAgents,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>
            {prompt ? "Edit Agent" : "Create New Agent"}
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
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="promptName">Name *</Label>
            <Input
              id="promptName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter prompt name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agentId">Tools *</Label>
            <p className="text-sm text-muted-foreground">
              Select profile with the tools that will be available
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ProfileSelector
                currentAgentId={agentId}
                onProfileChange={setProfileId}
              />
              {agentId && <ChatToolsDisplay agentId={agentId} readOnly />}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Agents</Label>
            <p className="text-sm text-muted-foreground">
              Select other agents to delegate tasks
            </p>
            <MultiSelect
              value={selectedAgentPromptIds}
              onValueChange={setSelectedAgentPromptIds}
              items={availableAgentPrompts}
              placeholder="Select agents..."
              disabled={availableAgentPrompts.length === 0}
            />
            {availableAgentPrompts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No other agent available
              </p>
            )}
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
          {chatopsProviders.filter((provider) => provider.configured).length >
            0 && (
            <div className="space-y-2">
              <Label>ChatOps Integrations</Label>
              <p className="text-sm text-muted-foreground">
                Select which chat platforms can trigger this agent
              </p>
            </div>
          )}
          {chatopsProviders
            .filter((provider) => provider.configured)
            .map((provider) => (
              <div key={provider.id} className="flex items-center space-x-2">
                <Checkbox
                  id={`chatops-${provider.id}`}
                  checked={allowedChatops.includes(provider.id)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setAllowedChatops([...allowedChatops, provider.id]);
                    } else {
                      setAllowedChatops(
                        allowedChatops.filter((id) => id !== provider.id),
                      );
                    }
                  }}
                />
                <Label
                  htmlFor={`chatops-${provider.id}`}
                  className={
                    !provider.configured
                      ? "text-muted-foreground cursor-not-allowed font-normal"
                      : "cursor-pointer font-normal"
                  }
                >
                  {provider.displayName}
                  {!provider.configured && " (not configured)"}
                </Label>
              </div>
            ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              !name.trim() ||
              !agentId ||
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
