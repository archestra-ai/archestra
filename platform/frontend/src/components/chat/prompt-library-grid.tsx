"use client";

import type { archestraApiTypes } from "@shared";
import {
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgents } from "@/lib/agent.query";

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

interface PromptLibraryGridProps {
  prompts: Prompt[];
  onSelectPrompt: (agentId: string, promptId?: string) => void;
  onEdit: (prompt: Prompt) => void;
  onDelete: (promptId: string) => void;
  onCreate: () => void;
}

export function PromptLibraryGrid({
  prompts,
  onSelectPrompt,
  onEdit,
  onDelete,
  onCreate,
}: PromptLibraryGridProps) {
  const { data: allAgents = [] } = useAgents();
  const agents = allAgents.filter((agent) => agent.useInChat);
  const [isFreeChatDialogOpen, setIsFreeChatDialogOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const handleFreeChatStart = () => {
    if (selectedAgentId) {
      onSelectPrompt(selectedAgentId);
      setIsFreeChatDialogOpen(false);
      setSelectedAgentId("");
    }
  };

  const handlePromptClick = (prompt: Prompt) => {
    onSelectPrompt(prompt.agentId, prompt.id);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Prompt Library</h1>
          <p className="text-muted-foreground mt-1">
            Start a chat with a profile or select a preset prompt
          </p>
        </div>
        <Button onClick={onCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add Prompt
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Free Chat Tile */}
        <Card
          className="border-2 border-green-500 hover:border-green-600 cursor-pointer transition-colors bg-gradient-to-br from-green-50 to-green-100 dark:from-green-950 dark:to-green-900"
          onClick={() => setIsFreeChatDialogOpen(true)}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-700 dark:text-green-300">
              <MessageSquarePlus className="h-5 w-5" />
              Free Chat
            </CardTitle>
            <CardDescription>
              Start a new conversation with any profile
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Choose a profile and start chatting without a preset prompt
            </p>
          </CardContent>
        </Card>

        {/* Prompt Tiles */}
        {prompts.map((prompt) => (
          <Card
            key={prompt.id}
            className="hover:border-primary cursor-pointer transition-colors group relative"
          >
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                {/* biome-ignore lint/a11y/useSemanticElements: Using div for layout within Card component */}
                <div
                  className="flex-1 min-w-0"
                  onClick={() => handlePromptClick(prompt)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handlePromptClick(prompt);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <CardTitle className="text-lg mb-2 truncate">
                    {prompt.name}
                  </CardTitle>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {prompt.systemPrompt && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="secondary"
                              className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 cursor-help"
                            >
                              System Prompt
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-md max-h-64 overflow-y-auto">
                            <pre className="text-xs whitespace-pre-wrap">
                              {prompt.systemPrompt}
                            </pre>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {prompt.userPrompt && (
                      <Badge
                        variant="secondary"
                        className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                      >
                        User Prompt
                      </Badge>
                    )}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    asChild
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 flex-shrink-0"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(prompt)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onDelete(prompt.id)}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>
            <CardContent
              className="space-y-3"
              onClick={() => handlePromptClick(prompt)}
            >
              {prompt.userPrompt && (
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {prompt.userPrompt}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Free Chat Agent Selection Dialog */}
      <Dialog
        open={isFreeChatDialogOpen}
        onOpenChange={setIsFreeChatDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start Free Chat</DialogTitle>
            <DialogDescription>
              Select a profile to start a new conversation
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">Profile</div>
              <Select
                value={selectedAgentId}
                onValueChange={setSelectedAgentId}
              >
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
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsFreeChatDialogOpen(false);
                setSelectedAgentId("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleFreeChatStart} disabled={!selectedAgentId}>
              Start Chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
