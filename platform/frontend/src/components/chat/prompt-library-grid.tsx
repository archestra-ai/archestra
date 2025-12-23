"use client";

import {
  type archestraApiTypes,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import {
  History as HistoryIcon,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useProfiles } from "@/lib/agent.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";
import { WithPermissions } from "../roles/with-permissions";
import { TruncatedText } from "../truncated-text";
import { AssignToolsToProfile } from "./assign-tools-to-profile";

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
  const { data: allProfiles = [] } = useProfiles();
  const agents = allProfiles;
  const [isFreeChatDialogOpen, setIsFreeChatDialogOpen] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [promptToDelete, setPromptToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (isFreeChatDialogOpen && !selectedProfileId && agents.length > 0) {
      setSelectedProfileId(agents[0].id);
    }
  }, [isFreeChatDialogOpen, agents, selectedProfileId]);

  // Filter prompts based on search query
  const filteredPrompts = useMemo(() => {
    if (!searchQuery.trim()) {
      return prompts;
    }

    const query = searchQuery.toLowerCase();
    return prompts.filter((prompt) => {
      const agentName =
        allProfiles.find((a) => a.id === prompt.agentId)?.name.toLowerCase() ||
        "";
      return (
        prompt.name.toLowerCase().includes(query) || agentName.includes(query)
      );
    });
  }, [prompts, searchQuery, allProfiles]);

  const handleFreeChatStart = () => {
    if (selectedProfileId) {
      onSelectPrompt(selectedProfileId);
      setIsFreeChatDialogOpen(false);
      setSelectedProfileId("");
    }
  };

  const handlePromptClick = (prompt: Prompt) => {
    onSelectPrompt(prompt.agentId, prompt.id);
  };

  return (
    <div>
      {/* Search Bar */}
      <div className="mb-6 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search prompts by name or profile..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 pr-9"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSearchQuery("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 hover:bg-transparent"
          >
            <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {/* Free Chat Tile */}
        <WithPermissions
          key="free-chat"
          permissions={{ conversation: ["create"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => {
            return (
              <Card
                className={`h-[155px] justify-center items-center px-0 py-2 border-2 border-green-500 hover:border-green-600 cursor-pointer transition-colors bg-gradient-to-br from-green-50 to-green-100 dark:from-green-950 dark:to-green-900 ${hasPermission === false ? "opacity-50 pointer-events-none" : ""}`}
                onClick={() => setIsFreeChatDialogOpen(true)}
              >
                <CardTitle className="flex items-center gap-2 text-green-700 dark:text-green-300 text-base">
                  <MessageSquarePlus className="h-4 w-4" />
                  Free Chat
                </CardTitle>
              </Card>
            );
          }}
        </WithPermissions>

        {/* Prompt Tiles */}
        {filteredPrompts.map((prompt) => {
          const profileName = prompt.agentId
            ? allProfiles.find((a) => a.id === prompt.agentId)?.name
            : null;

          return (
            <WithPermissions
              key={prompt.id}
              permissions={{ conversation: ["create"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => {
                return (
                  <PromptTile
                    key={prompt.id}
                    prompt={prompt}
                    profileName={profileName}
                    onPromptClick={handlePromptClick}
                    onEdit={onEdit}
                    onDelete={setPromptToDelete}
                    onViewVersionHistory={onViewVersionHistory}
                    disabled={hasPermission === false}
                  />
                );
              }}
            </WithPermissions>
          );
        })}
      </div>

      {/* Free Chat Profile Selection Dialog */}
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
          <div className="space-y-4 py-6">
            <div className="space-y-2">
              <Select
                value={selectedProfileId}
                onValueChange={setSelectedProfileId}
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
              {selectedProfileId && (
                <WithPermissions
                  permissions={{ profile: ["read"] }}
                  noPermissionHandle="hide"
                >
                  <AssignToolsToProfile
                    agentId={selectedProfileId}
                    showAssignedToolsList
                    className="text-xs text-muted-foreground"
                  />
                </WithPermissions>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsFreeChatDialogOpen(false);
                setSelectedProfileId("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleFreeChatStart} disabled={!selectedProfileId}>
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

// Separate component to use MCP tools hook
interface PromptTileProps {
  prompt: Prompt;
  profileName: string | null | undefined;
  onPromptClick: (prompt: Prompt) => void;
  onEdit: (prompt: Prompt) => void;
  onDelete: (promptId: string) => void;
  onViewVersionHistory: (prompt: Prompt) => void;
  disabled?: boolean;
}

interface PromptMcpToolsDisplayProps {
  agentId: string;
}

function PromptMcpToolsDisplay({ agentId }: PromptMcpToolsDisplayProps) {
  const { data: mcpTools = [] } = useChatProfileMcpTools(agentId);

  // Group tools by MCP server name (same logic as McpToolsDisplay)
  const groupedTools = useMemo(
    () =>
      mcpTools.reduce(
        (acc, tool) => {
          const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
          const serverName =
            parts.length > 1
              ? parts.slice(0, -1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
              : "default";
          if (!acc[serverName]) {
            acc[serverName] = [];
          }
          acc[serverName].push(tool);
          return acc;
        },
        {} as Record<string, typeof mcpTools>,
      ),
    [mcpTools],
  );

  if (Object.keys(groupedTools).length === 0) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">
        MCP Tools:
      </div>
      {Object.entries(groupedTools).map(([serverName, tools]) => (
        <div key={serverName} className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-medium">{serverName}</span>
            <span className="text-muted-foreground">
              ({tools.length} {tools.length === 1 ? "tool" : "tools"})
            </span>
          </div>
          <div className="space-y-0.5 pl-2">
            {tools.map((tool) => {
              const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
              const toolName =
                parts.length > 1 ? parts[parts.length - 1] : tool.name;
              return (
                <div
                  key={tool.name}
                  className="text-xs border-l-2 border-primary/30 pl-2 py-0.5"
                >
                  <div className="font-mono font-medium">{toolName}</div>
                  {tool.description && (
                    <div className="text-muted-foreground mt-0.5">
                      {tool.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PromptTile({
  prompt,
  profileName,
  onPromptClick,
  onEdit,
  onDelete,
  onViewVersionHistory,
  disabled = false,
}: PromptTileProps) {
  const handlePromptClick = () => onPromptClick(prompt);

  return (
    <Card
      className={`h-[155px] justify-between px-0 py-1.5 hover:border-primary cursor-pointer transition-colors group relative ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      onClick={handlePromptClick}
    >
      <CardHeader className="px-4 relative">
        <div className="flex items-start justify-between gap-2">
          {/* biome-ignore lint/a11y/useSemanticElements: Using div for layout within Card component */}
          <div
            className="flex-1 min-w-0 max-w-[calc(100%-2rem)]"
            onClick={handlePromptClick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handlePromptClick();
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="flex items-baseline gap-2 overflow-hidden">
              <CardTitle className="text-base truncate flex-1 min-w-0">
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
          </div>
        </div>
        <WithPermissions
          permissions={{ prompt: ["update"] }}
          noPermissionHandle="hide"
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              asChild
              onClick={(e) => e.stopPropagation()}
              className="absolute top-[-8px] right-2"
            >
              <Button
                variant="ghost"
                size="icon"
                className="p-4 mt-2 h-6 w-6 flex-shrink-0"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(prompt);
                }}
              >
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
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(prompt.id);
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </WithPermissions>
      </CardHeader>
      {prompt.userPrompt && (
        <div className="px-4 text-xs text-muted-foreground line-clamp-3 flex-1">
          <TruncatedText
            message={prompt.userPrompt}
            className="text-xs"
            maxLength={75}
          />
        </div>
      )}
      <div className="px-4 pb-1.5 mt-auto">
        <div className="flex flex-wrap gap-1">
          {profileName && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 text-xs cursor-default"
                  >
                    {profileName}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-sm max-h-64 overflow-y-auto"
                >
                  <div className="space-y-2">
                    <div className="font-medium text-sm">
                      Profile: {profileName}
                    </div>
                    <WithPermissions
                      permissions={{ profile: ["read"] }}
                      noPermissionHandle="hide"
                    >
                      <PromptMcpToolsDisplay agentId={prompt.agentId} />
                    </WithPermissions>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </Card>
  );
}
