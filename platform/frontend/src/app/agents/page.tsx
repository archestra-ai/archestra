"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  History,
  Link2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { PromptDialog } from "@/components/chat/prompt-dialog";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { DebouncedInput } from "@/components/debounced-input";
import { PageLayout } from "@/components/page-layout";
import { WithPermissions } from "@/components/roles/with-permissions";
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
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import { useDeletePrompt, usePrompt, usePrompts } from "@/lib/prompts.query";
import { formatDate } from "@/lib/utils";

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

export default function AgentsPage() {
  const { data: prompts = [] } = usePrompts();
  const { data: allProfiles = [] } = useProfiles();
  const deletePromptMutation = useDeletePrompt();

  const [searchQuery, setSearchQuery] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);

  // Dialog state
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [versionHistoryPrompt, setVersionHistoryPrompt] =
    useState<Prompt | null>(null);
  const [promptToDelete, setPromptToDelete] = useState<string | null>(null);
  const [promptToConnect, setPromptToConnect] = useState<Prompt | null>(null);

  const { data: editingPrompt } = usePrompt(editingPromptId || "");

  // Filter prompts based on search query
  const filteredPrompts = useMemo(() => {
    if (!searchQuery.trim()) {
      return prompts;
    }
    const query = searchQuery.toLowerCase();
    return prompts.filter((prompt) => {
      const profileName =
        allProfiles.find((a) => a.id === prompt.agentId)?.name.toLowerCase() ||
        "";
      return (
        prompt.name.toLowerCase().includes(query) || profileName.includes(query)
      );
    });
  }, [prompts, searchQuery, allProfiles]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);
    },
    [sorting],
  );

  const handleCreatePrompt = useCallback(() => {
    setEditingPromptId(null);
    setIsPromptDialogOpen(true);
  }, []);

  const handleEditPrompt = useCallback((prompt: Prompt) => {
    setEditingPromptId(prompt.id);
    setIsPromptDialogOpen(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (promptToDelete) {
      await deletePromptMutation.mutateAsync(promptToDelete);
      setPromptToDelete(null);
    }
  }, [promptToDelete, deletePromptMutation]);

  const columns: ColumnDef<Prompt>[] = [
    {
      id: "name",
      accessorKey: "name",
      size: 300,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const prompt = row.original;
        return (
          <div className="font-medium">
            <div className="flex items-center gap-2">
              {prompt.name}
              <span className="text-xs text-muted-foreground">
                v{prompt.version}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      id: "profile",
      header: "Profile",
      cell: ({ row }) => {
        const prompt = row.original;
        const profileName = allProfiles.find(
          (p) => p.id === prompt.agentId,
        )?.name;
        return profileName ? (
          <Badge
            variant="secondary"
            className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
          >
            {profileName}
          </Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      },
    },
    {
      id: "userPrompt",
      header: "User Prompt",
      size: 400,
      cell: ({ row }) => {
        const prompt = row.original;
        if (!prompt.userPrompt) {
          return <span className="text-muted-foreground">-</span>;
        }
        const truncated =
          prompt.userPrompt.length > 100
            ? `${prompt.userPrompt.substring(0, 100)}...`
            : prompt.userPrompt;
        return (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-sm text-muted-foreground cursor-help">
                  {truncated}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">
                <p className="whitespace-pre-wrap">{prompt.userPrompt}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      },
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Created
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 100,
      enableHiding: false,
      cell: ({ row }) => {
        const prompt = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <WithPermissions
                permissions={{ prompt: ["update"] }}
                noPermissionHandle="hide"
              >
                <DropdownMenuItem onClick={() => handleEditPrompt(prompt)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
              </WithPermissions>
              <DropdownMenuItem onClick={() => setVersionHistoryPrompt(prompt)}>
                <History className="mr-2 h-4 w-4" />
                Version History
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPromptToConnect(prompt)}>
                <Link2 className="mr-2 h-4 w-4" />
                A2A Connect
              </DropdownMenuItem>
              <WithPermissions
                permissions={{ prompt: ["delete"] }}
                noPermissionHandle="hide"
              >
                <DropdownMenuItem onClick={() => setPromptToDelete(prompt.id)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </WithPermissions>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const hasNoProfiles = allProfiles.length === 0;

  return (
    <ErrorBoundary>
      <PageLayout
        title="Agents"
        description={
          <p className="text-sm text-muted-foreground">
            Agents are pre-configured prompts that can be used to start
            conversations with specific system prompts and user prompts.
          </p>
        }
        actionButton={
          <WithPermissions
            permissions={{ prompt: ["create"] }}
            noPermissionHandle="hide"
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <PermissionButton
                      permissions={{ prompt: ["create"] }}
                      onClick={handleCreatePrompt}
                      disabled={hasNoProfiles}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Create Agent
                    </PermissionButton>
                  </span>
                </TooltipTrigger>
                {hasNoProfiles && (
                  <TooltipContent>
                    <p>No profiles available. Create a profile first.</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </WithPermissions>
        }
      >
        <div>
          <div className="mb-6">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <DebouncedInput
                placeholder="Search agents by name or profile..."
                initialValue={searchQuery}
                onChange={handleSearchChange}
                className="pl-9"
              />
            </div>
          </div>

          {filteredPrompts.length === 0 ? (
            <div className="text-muted-foreground">
              {searchQuery
                ? "No agents found matching your search"
                : "No agents found. Create one to get started."}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={filteredPrompts}
              sorting={sorting}
              onSortingChange={handleSortingChange}
            />
          )}

          {/* Create/Edit Prompt Dialog */}
          <PromptDialog
            open={isPromptDialogOpen}
            onOpenChange={(open) => {
              setIsPromptDialogOpen(open);
              if (!open) {
                setEditingPromptId(null);
              }
            }}
            prompt={editingPrompt}
            onViewVersionHistory={setVersionHistoryPrompt}
          />

          {/* Version History Dialog */}
          <PromptVersionHistoryDialog
            open={!!versionHistoryPrompt}
            onOpenChange={(open) => {
              if (!open) {
                setVersionHistoryPrompt(null);
              }
            }}
            prompt={versionHistoryPrompt}
          />

          {/* Delete Confirmation Dialog */}
          <AlertDialog
            open={!!promptToDelete}
            onOpenChange={(open) => !open && setPromptToDelete(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Agent</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this agent? This action cannot
                  be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={confirmDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* A2A Connection Dialog */}
          <Dialog
            open={!!promptToConnect}
            onOpenChange={(open) => !open && setPromptToConnect(null)}
          >
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  Connect to &quot;{promptToConnect?.name}&quot;
                </DialogTitle>
                <DialogDescription>
                  Use these details to connect to this agent as an A2A agent
                  from your application.
                </DialogDescription>
              </DialogHeader>
              {promptToConnect && (
                <A2AConnectionInstructions prompt={promptToConnect} />
              )}
            </DialogContent>
          </Dialog>
        </div>
      </PageLayout>
    </ErrorBoundary>
  );
}
