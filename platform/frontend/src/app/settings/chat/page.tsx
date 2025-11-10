"use client";

import type { archestraApiTypes } from "@shared";
import {
  CheckCircle2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useChatSettings,
  useUpdateChatSettings,
} from "@/lib/chat-settings.query";
import {
  useCreatePrompt,
  useDeletePrompt,
  usePrompts,
  useUpdatePrompt,
} from "@/lib/prompts.query";

const PLACEHOLDER_KEY = "••••••••••••••••";

function ChatSettingsContent() {
  const { data: chatSettings } = useChatSettings();
  const { data: prompts } = usePrompts();
  const updateChatSettings = useUpdateChatSettings();
  const createPrompt = useCreatePrompt();
  const updatePrompt = useUpdatePrompt();
  const deletePrompt = useDeletePrompt();

  const [apiKey, setApiKey] = useState("");
  const [hasApiKeyChanged, setHasApiKeyChanged] = useState(false);
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<{
    id?: string;
    name: string;
    type: "system" | "regular";
    content: string;
  } | null>(null);

  // Set placeholder dots when API key is configured
  useEffect(() => {
    if (chatSettings?.anthropicApiKeySecretId) {
      setApiKey(PLACEHOLDER_KEY);
      setHasApiKeyChanged(false);
    }
  }, [chatSettings?.anthropicApiKeySecretId]);

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    // Mark as changed if user modified the field
    if (chatSettings?.anthropicApiKeySecretId) {
      // If key exists, changed means it's different from placeholder
      setHasApiKeyChanged(value !== PLACEHOLDER_KEY);
    } else {
      // If no key exists, any non-empty value is a change
      setHasApiKeyChanged(value !== "");
    }
  };

  const handleSaveApiKey = async () => {
    try {
      // Only send the API key if it's been changed from the placeholder
      const keyToSend = hasApiKeyChanged ? apiKey : undefined;

      await updateChatSettings.mutateAsync({
        anthropicApiKey: keyToSend,
      });
      toast.success("API key saved successfully");

      // Reset to placeholder dots if key was configured
      if (chatSettings?.anthropicApiKeySecretId || keyToSend) {
        setApiKey(PLACEHOLDER_KEY);
        setHasApiKeyChanged(false);
      } else {
        setApiKey("");
      }
    } catch (_error) {
      toast.error("Failed to save API key");
    }
  };

  const handleCancelApiKey = () => {
    // Reset to placeholder dots if key exists, otherwise empty
    if (chatSettings?.anthropicApiKeySecretId) {
      setApiKey(PLACEHOLDER_KEY);
    } else {
      setApiKey("");
    }
    setHasApiKeyChanged(false);
  };

  const handleResetApiKey = async () => {
    if (
      !confirm(
        "Are you sure you want to reset the Anthropic API key? Chat functionality will stop working until a new key is configured.",
      )
    ) {
      return;
    }

    try {
      await updateChatSettings.mutateAsync({
        resetApiKey: true,
      });
      toast.success("API key reset successfully");
      setApiKey("");
      setHasApiKeyChanged(false);
    } catch (_error) {
      toast.error("Failed to reset API key");
    }
  };

  const handleCreatePrompt = () => {
    setEditingPrompt({
      name: "",
      type: "system",
      content: "",
    });
    setIsPromptDialogOpen(true);
  };

  const handleEditPrompt = (
    prompt: archestraApiTypes.GetPromptsResponses["200"][number],
  ) => {
    setEditingPrompt({
      id: prompt.id,
      name: prompt.name,
      type: prompt.type,
      content: prompt.content,
    });
    setIsPromptDialogOpen(true);
  };

  const handleSavePrompt = async () => {
    if (!editingPrompt) return;

    try {
      if (editingPrompt.id) {
        await updatePrompt.mutateAsync({
          id: editingPrompt.id,
          data: {
            name: editingPrompt.name,
            content: editingPrompt.content,
          },
        });
        toast.success("Prompt updated successfully");
      } else {
        await createPrompt.mutateAsync({
          name: editingPrompt.name,
          type: editingPrompt.type,
          content: editingPrompt.content,
        });
        toast.success("Prompt created successfully");
      }
      setIsPromptDialogOpen(false);
      setEditingPrompt(null);
    } catch (_error) {
      toast.error("Failed to save prompt");
    }
  };

  const handleDeletePrompt = async (id: string) => {
    if (!confirm("Are you sure you want to delete this prompt?")) return;

    try {
      await deletePrompt.mutateAsync(id);
      toast.success("Prompt deleted successfully");
    } catch (_error) {
      toast.error("Failed to delete prompt");
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full space-y-6">
      {/* API Key Section */}
      <Card>
        <CardHeader>
          <CardTitle>Anthropic API Key</CardTitle>
          <CardDescription>
            Configure the Anthropic API key for chat functionality
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <div className="relative">
              <Input
                id="apiKey"
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                className={
                  chatSettings?.anthropicApiKeySecretId && !hasApiKeyChanged
                    ? "border-green-500 pr-10"
                    : ""
                }
              />
              {chatSettings?.anthropicApiKeySecretId && !hasApiKeyChanged && (
                <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
              )}
            </div>
          </div>
          {hasApiKeyChanged ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleCancelApiKey}
                disabled={updateChatSettings.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveApiKey}
                disabled={updateChatSettings.isPending || !apiKey}
              >
                {updateChatSettings.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {chatSettings?.anthropicApiKeySecretId
                  ? "Update API Key"
                  : "Save API Key"}
              </Button>
            </div>
          ) : (
            chatSettings?.anthropicApiKeySecretId && (
              <Button
                variant="destructive"
                onClick={handleResetApiKey}
                disabled={updateChatSettings.isPending}
              >
                {updateChatSettings.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset API Key
              </Button>
            )
          )}
        </CardContent>
      </Card>

      {/* Prompt Library Section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Prompt Library</CardTitle>
            <CardDescription>
              Manage system and regular prompts for your agents
            </CardDescription>
          </div>
          <Button onClick={handleCreatePrompt}>
            <Plus className="mr-2 h-4 w-4" />
            New Prompt
          </Button>
        </CardHeader>
        <CardContent>
          {prompts && prompts.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {prompts.map((prompt) => (
                <Card key={prompt.id} className="flex flex-col relative">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4 overflow-hidden">
                      <div className="min-w-0 flex-1">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="text-lg font-semibold mb-1 cursor-help overflow-hidden whitespace-nowrap text-ellipsis w-full">
                                {prompt.name}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="max-w-xs break-words">
                                {prompt.name}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="secondary"
                            className={
                              prompt.type === "system"
                                ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                                : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                            }
                          >
                            {prompt.type}
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            v{prompt.version}
                          </span>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 flex-shrink-0"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handleEditPrompt(prompt)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDeletePrompt(prompt.id)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground line-clamp-3">
                      {prompt.content}
                    </p>
                    {prompt.agents && prompt.agents.length > 0 ? (
                      <div className="text-xs text-muted-foreground pt-2 border-t">
                        <span className="font-medium">
                          Agents using: {prompt.agents.length}
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {prompt.agents.map((agent) => (
                            <span
                              key={agent.id}
                              className="inline-flex items-center px-2 py-0.5 rounded-md bg-secondary text-foreground"
                            >
                              {agent.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground pt-2 border-t">
                        <span className="font-medium">
                          Not assigned to any agents
                        </span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>No prompts created yet</p>
              <p className="text-sm mt-1">
                Click &quot;New Prompt&quot; to create your first prompt
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Prompt Editor Dialog */}
      <Dialog open={isPromptDialogOpen} onOpenChange={setIsPromptDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingPrompt?.id ? "Edit Prompt" : "Create New Prompt"}
            </DialogTitle>
            <DialogDescription>
              {editingPrompt?.id
                ? "Update the prompt. This will create a new version."
                : "Create a new prompt for your agents."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="promptName">Name</Label>
              <Input
                id="promptName"
                value={editingPrompt?.name || ""}
                onChange={(e) =>
                  setEditingPrompt((prev) =>
                    prev ? { ...prev, name: e.target.value } : null,
                  )
                }
                placeholder="Enter prompt name"
              />
            </div>
            {!editingPrompt?.id && (
              <div className="space-y-2">
                <Label htmlFor="promptType">Type</Label>
                <Select
                  value={editingPrompt?.type || "system"}
                  onValueChange={(value: "system" | "regular") =>
                    setEditingPrompt((prev) =>
                      prev ? { ...prev, type: value } : null,
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="regular">Regular</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="promptContent">Content</Label>
              <Textarea
                id="promptContent"
                value={editingPrompt?.content || ""}
                onChange={(e) =>
                  setEditingPrompt((prev) =>
                    prev ? { ...prev, content: e.target.value } : null,
                  )
                }
                placeholder="Enter prompt content"
                className="min-h-[300px] font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsPromptDialogOpen(false);
                setEditingPrompt(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSavePrompt}
              disabled={
                !editingPrompt?.name ||
                !editingPrompt?.content ||
                createPrompt.isPending ||
                updatePrompt.isPending
              }
            >
              {(createPrompt.isPending || updatePrompt.isPending) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editingPrompt?.id ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ChatSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <ChatSettingsContent />
    </Suspense>
  );
}
