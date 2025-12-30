"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Badge } from "@/components/ui/badge";
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
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useProfiles } from "@/lib/agent.query";
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

  // Available prompts that can be used as agents (excluding self)
  const availableAgentPrompts = useMemo(() => {
    return allPrompts
      .filter((p) => p.id !== prompt?.id && p.isActive)
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
      } else {
        // create
        setName("");
        setUserPrompt("");
        setSystemPrompt("");
        setSelectedAgentPromptIds([]);
      }
    } else {
      // reset form
      setName("");
      setProfileId("");
      setUserPrompt("");
      setSystemPrompt("");
      setSelectedAgentPromptIds([]);
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
        // Update creates a new version with a new ID
        const updated = await updatePrompt.mutateAsync({
          id: prompt.id,
          data: {
            name: trimmedName,
            agentId,
            userPrompt: trimmedUserPrompt || undefined,
            systemPrompt: trimmedSystemPrompt || undefined,
          },
        });
        // Use the new version's ID for agent sync
        promptId = updated?.id ?? prompt.id;
        toast.success("New version created successfully");
      } else {
        const created = await createPrompt.mutateAsync({
          name: trimmedName,
          agentId,
          userPrompt: trimmedUserPrompt || undefined,
          systemPrompt: trimmedSystemPrompt || undefined,
        });
        promptId = created?.id ?? "";
        toast.success("Prompt created successfully");
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
      toast.error("Failed to save prompt");
    }
  }, [
    name,
    agentId,
    userPrompt,
    systemPrompt,
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
              : "Create a new prompt for a profile. It will be shared across your organization."}
          </DialogDescription>
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
            <Label htmlFor="agentId">Profile with tools*</Label>
            <WithPermissions
              permissions={{ profile: ["read"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => {
                return hasPermission === undefined ? null : hasPermission ? (
                  <Select value={agentId} onValueChange={setProfileId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a profile" />
                    </SelectTrigger>
                    <SelectContent>
                      {allProfiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    Unable to show the list of profiles
                  </Badge>
                );
              }}
            </WithPermissions>
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
          <div className="space-y-2">
            <Label>Agents</Label>
            <p className="text-sm text-muted-foreground">
              Select agents that this prompt can delegate tasks to. Each agent
              becomes a tool available to the LLM.
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
                No other prompts available to use as agents.
              </p>
            )}
          </div>
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
