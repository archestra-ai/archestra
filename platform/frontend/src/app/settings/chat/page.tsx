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
  useChatModels,
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

type ChatProvider = "anthropic" | "openai";

function ChatSettingsContent() {
  const { data: chatSettings } = useChatSettings();
  const { data: prompts } = usePrompts();
  const updateChatSettings = useUpdateChatSettings();
  const createPrompt = useCreatePrompt();
  const updatePrompt = useUpdatePrompt();
  const deletePrompt = useDeletePrompt();

  const [provider, setProvider] = useState<ChatProvider>("anthropic");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [hasAnthropicKeyChanged, setHasAnthropicKeyChanged] = useState(false);
  const [hasOpenaiKeyChanged, setHasOpenaiKeyChanged] = useState(false);
  const [hasModelChanged, setHasModelChanged] = useState(false);
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<{
    id?: string;
    name: string;
    type: "system" | "regular";
    content: string;
  } | null>(null);

  // Set initial values when chat settings load
  useEffect(() => {
    if (chatSettings) {
      setProvider(chatSettings.provider || "anthropic");
      setSelectedModel(chatSettings.model || "");
      setHasModelChanged(false);

      if (chatSettings.anthropicApiKeySecretId) {
        setAnthropicApiKey(PLACEHOLDER_KEY);
        setHasAnthropicKeyChanged(false);
      }

      if (chatSettings.openaiApiKeySecretId) {
        setOpenaiApiKey(PLACEHOLDER_KEY);
        setHasOpenaiKeyChanged(false);
      }
    }
  }, [chatSettings]);

  const handleAnthropicApiKeyChange = (value: string) => {
    setAnthropicApiKey(value);
    if (chatSettings?.anthropicApiKeySecretId) {
      setHasAnthropicKeyChanged(value !== PLACEHOLDER_KEY);
    } else {
      setHasAnthropicKeyChanged(value !== "");
    }
  };

  const handleOpenaiApiKeyChange = (value: string) => {
    setOpenaiApiKey(value);
    if (chatSettings?.openaiApiKeySecretId) {
      setHasOpenaiKeyChanged(value !== PLACEHOLDER_KEY);
    } else {
      setHasOpenaiKeyChanged(value !== "");
    }
  };

  const handleSaveSettings = async () => {
    try {
      const anthropicKey = hasAnthropicKeyChanged ? anthropicApiKey : undefined;
      const openaiKey = hasOpenaiKeyChanged ? openaiApiKey : undefined;
      const modelToSave = hasModelChanged ? selectedModel : undefined;

      await updateChatSettings.mutateAsync({
        provider,
        model: modelToSave,
        anthropicApiKey: anthropicKey,
        openaiApiKey: openaiKey,
      });
      toast.success("Settings saved successfully");

      // Reset to placeholder dots if keys were configured
      if (chatSettings?.anthropicApiKeySecretId || anthropicKey) {
        setAnthropicApiKey(PLACEHOLDER_KEY);
        setHasAnthropicKeyChanged(false);
      }
      if (chatSettings?.openaiApiKeySecretId || openaiKey) {
        setOpenaiApiKey(PLACEHOLDER_KEY);
        setHasOpenaiKeyChanged(false);
      }
      setHasModelChanged(false);
    } catch (_error) {
      toast.error("Failed to save settings");
    }
  };

  const handleCancelChanges = () => {
    // Reset provider
    setProvider(chatSettings?.provider || "anthropic");

    // Reset model
    setSelectedModel(chatSettings?.model || "");
    setHasModelChanged(false);

    // Reset Anthropic API key
    if (chatSettings?.anthropicApiKeySecretId) {
      setAnthropicApiKey(PLACEHOLDER_KEY);
    } else {
      setAnthropicApiKey("");
    }
    setHasAnthropicKeyChanged(false);

    // Reset OpenAI API key
    if (chatSettings?.openaiApiKeySecretId) {
      setOpenaiApiKey(PLACEHOLDER_KEY);
    } else {
      setOpenaiApiKey("");
    }
    setHasOpenaiKeyChanged(false);
  };

  const handleResetAnthropicApiKey = async () => {
    if (!confirm("Are you sure you want to reset the Anthropic API key?")) {
      return;
    }

    try {
      await updateChatSettings.mutateAsync({
        resetAnthropicApiKey: true,
      });
      toast.success("Anthropic API key reset successfully");
      setAnthropicApiKey("");
      setHasAnthropicKeyChanged(false);
    } catch (_error) {
      toast.error("Failed to reset Anthropic API key");
    }
  };

  const handleResetOpenaiApiKey = async () => {
    if (!confirm("Are you sure you want to reset the OpenAI API key?")) {
      return;
    }

    try {
      await updateChatSettings.mutateAsync({
        resetOpenaiApiKey: true,
      });
      toast.success("OpenAI API key reset successfully");
      setOpenaiApiKey("");
      setHasOpenaiKeyChanged(false);
    } catch (_error) {
      toast.error("Failed to reset OpenAI API key");
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

  // Check if current provider has an API key saved in database
  const hasApiKeyForCurrentProvider =
    (provider === "anthropic" && chatSettings?.anthropicApiKeySecretId) ||
    (provider === "openai" && chatSettings?.openaiApiKeySecretId);

  // Fetch models only when API key exists for selected provider
  const { data: modelsData } = useChatModels(
    hasApiKeyForCurrentProvider ? provider : undefined,
  );

  // Reset model when provider changes
  useEffect(() => {
    if (chatSettings && provider !== chatSettings.provider) {
      setSelectedModel("");
      setHasModelChanged(true);
    }
  }, [provider, chatSettings]);

  const hasChanges =
    hasAnthropicKeyChanged ||
    hasOpenaiKeyChanged ||
    hasModelChanged ||
    provider !== (chatSettings?.provider || "anthropic");

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full space-y-6">
      {/* Provider and API Keys Section */}
      <Card>
        <CardHeader>
          <CardTitle>Chat Provider Settings</CardTitle>
          <CardDescription>
            Configure the AI provider and API keys for chat functionality
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Provider Selection - Temporarily disabled, only Anthropic supported */}
          <div className="space-y-2">
            <Label htmlFor="provider">AI Provider</Label>
            <Select value={provider} disabled>
              <SelectTrigger id="provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                {/* <SelectItem value="openai">OpenAI (GPT)</SelectItem> */}
              </SelectContent>
            </Select>
          </div>

          {/* Anthropic API Key - Only show for Anthropic provider */}
          {provider === "anthropic" && (
            <div className="space-y-2">
              <Label htmlFor="anthropicApiKey">Anthropic API Key</Label>
              <div className="relative">
                <Input
                  id="anthropicApiKey"
                  type="password"
                  placeholder="sk-ant-..."
                  value={anthropicApiKey}
                  onChange={(e) => handleAnthropicApiKeyChange(e.target.value)}
                  className={
                    chatSettings?.anthropicApiKeySecretId &&
                    !hasAnthropicKeyChanged
                      ? "border-green-500 pr-10"
                      : ""
                  }
                />
                {chatSettings?.anthropicApiKeySecretId &&
                  !hasAnthropicKeyChanged && (
                    <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                  )}
              </div>
              {chatSettings?.anthropicApiKeySecretId &&
                !hasAnthropicKeyChanged && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleResetAnthropicApiKey}
                    disabled={updateChatSettings.isPending}
                  >
                    <RotateCcw className="mr-2 h-3 w-3" />
                    Reset Anthropic Key
                  </Button>
                )}
            </div>
          )}

          {/* OpenAI API Key - Only show for OpenAI provider */}
          {provider === "openai" && (
            <div className="space-y-2">
              <Label htmlFor="openaiApiKey">OpenAI API Key</Label>
              <div className="relative">
                <Input
                  id="openaiApiKey"
                  type="password"
                  placeholder="sk-..."
                  value={openaiApiKey}
                  onChange={(e) => handleOpenaiApiKeyChange(e.target.value)}
                  className={
                    chatSettings?.openaiApiKeySecretId && !hasOpenaiKeyChanged
                      ? "border-green-500 pr-10"
                      : ""
                  }
                />
                {chatSettings?.openaiApiKeySecretId && !hasOpenaiKeyChanged && (
                  <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
                )}
              </div>
              {chatSettings?.openaiApiKeySecretId && !hasOpenaiKeyChanged && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetOpenaiApiKey}
                  disabled={updateChatSettings.isPending}
                >
                  <RotateCcw className="mr-2 h-3 w-3" />
                  Reset OpenAI Key
                </Button>
              )}
            </div>
          )}

          {/* Model Selection - Show only when API key is configured for current provider */}
          {hasApiKeyForCurrentProvider &&
            modelsData?.models &&
            modelsData.models.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="model">Model</Label>
                <Select
                  value={selectedModel}
                  onValueChange={(value: string) => {
                    setSelectedModel(value);
                    setHasModelChanged(value !== (chatSettings?.model || ""));
                  }}
                >
                  <SelectTrigger id="model">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsData.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name || model.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

          {/* Save/Cancel Buttons */}
          {hasChanges && (
            <div className="flex gap-2 pt-4 border-t">
              <Button
                variant="outline"
                onClick={handleCancelChanges}
                disabled={updateChatSettings.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveSettings}
                disabled={updateChatSettings.isPending}
              >
                {updateChatSettings.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Save Settings
              </Button>
            </div>
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
