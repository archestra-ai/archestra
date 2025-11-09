"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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

  const handleCreatePrompt = () => {
    setEditingPrompt({
      name: "",
      type: "system",
      content: "",
    });
    setIsPromptDialogOpen(true);
  };

  const handleEditPrompt = (prompt: any) => {
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
            <Input
              id="apiKey"
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
            />
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
              <div className="flex items-center gap-2 p-3 bg-green-50 text-green-800 rounded-md border border-green-200">
                <svg
                  className="h-5 w-5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span className="text-sm font-medium">
                  API key is configured
                </span>
              </div>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prompts && prompts.length > 0 ? (
                prompts.map((prompt) => (
                  <TableRow key={prompt.id}>
                    <TableCell className="font-medium">{prompt.name}</TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                          prompt.type === "system"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-green-100 text-green-800"
                        }`}
                      >
                        {prompt.type}
                      </span>
                    </TableCell>
                    <TableCell>v{prompt.version}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEditPrompt(prompt)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeletePrompt(prompt.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-muted-foreground"
                  >
                    No prompts created yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
