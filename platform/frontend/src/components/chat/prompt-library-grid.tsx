"use client";

import type { archestraApiTypes } from "@shared";
import {
  History as HistoryIcon,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { McpToolsDisplay } from "@/components/chat/mcp-tools-display";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { TruncatedText } from "../truncated-text";

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

interface PromptLibraryGridProps {
  prompts: Prompt[];
  onSelectPrompt: (agentId: string, promptId?: string) => void;
  onEdit: (prompt: Prompt) => void;
  onDelete: (promptId: string) => void;
  onViewVersionHistory: (prompt: Prompt) => void;
}

export function PromptLibraryGrid({
  prompts,
  onSelectPrompt,
  onEdit,
  onDelete,
  onViewVersionHistory,
}: PromptLibraryGridProps) {
  const { data: allAgents = [] } = useAgents();
  const agents = allAgents.filter((agent) => agent.useInChat);
  const [isFreeChatDialogOpen, setIsFreeChatDialogOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [promptToDelete, setPromptToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Filter prompts based on search query
  const filteredPrompts = useMemo(() => {
    if (!searchQuery.trim()) {
      return prompts;
    }

    const query = searchQuery.toLowerCase();
    return prompts.filter((prompt) => {
      const agentName =
        allAgents.find((a) => a.id === prompt.agentId)?.name.toLowerCase() ||
        "";
      return (
        prompt.name.toLowerCase().includes(query) || agentName.includes(query)
      );
    });
  }, [prompts, searchQuery, allAgents]);

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
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      {/* Search Bar */}
      <div className="mb-6 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search prompts by name or profile..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {/* Free Chat Tile */}
        <Card
          className="min-h-[136px] justify-center items-center px-0 py-2 border-2 border-green-500 hover:border-green-600 cursor-pointer transition-colors bg-gradient-to-br from-green-50 to-green-100 dark:from-green-950 dark:to-green-900"
          onClick={() => setIsFreeChatDialogOpen(true)}
        >
          <CardTitle className="flex items-center gap-2 text-green-700 dark:text-green-300 text-base">
            <MessageSquarePlus className="h-4 w-4" />
            Free Chat
          </CardTitle>
        </Card>

        {/* Prompt Tiles */}
        {filteredPrompts.map((prompt) => (
          <Card
            key={prompt.id}
            className="justify-between px-0 py-2 hover:border-primary cursor-pointer transition-colors group relative"
            onClick={() => handlePromptClick(prompt)}
          >
            <CardHeader className="pb-2 px-4 relative">
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
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <CardTitle className="text-base truncate">
                      <TruncatedText
                        message={prompt.name}
                        className="text-base truncate pr-0"
                        maxLength={25}
                      />
                    </CardTitle>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      v{prompt.version}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {prompt.systemPrompt && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="secondary"
                              className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 text-xs"
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
                    <Badge
                      variant="secondary"
                      className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 text-xs"
                    >
                      {allAgents.find((a) => a.id === prompt.agentId)?.name ||
                        "Unknown Profile"}
                    </Badge>
                    <McpToolsDisplay agentId={prompt.agentId} />
                  </div>
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  asChild
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-[-2px] right-2"
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className=" mt-2 h-4 w-4 flex-shrink-0"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onEdit(prompt)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewVersionHistory(prompt);
                    }}
                  >
                    <HistoryIcon className="mr-2 h-4 w-4" />
                    Version History
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setPromptToDelete(prompt.id)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardHeader>
            <CardContent className="pt-0 pb-3 space-y-2">
              {prompt.userPrompt && (
                <>
                  <span className="text-xs">User prompt:</span>
                  <TruncatedText
                    message={prompt.userPrompt}
                    className="text-xs text-muted-foreground line-clamp-2"
                    maxLength={100}
                  />
                </>
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Start Free Chat</DialogTitle>
            <DialogDescription>
              Select a profile to start a new conversation
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
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

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!promptToDelete}
        onOpenChange={(open) => !open && setPromptToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Prompt</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this prompt? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (promptToDelete) {
                  onDelete(promptToDelete);
                  setPromptToDelete(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
