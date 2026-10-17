"use client";

import { PROJECT_NAME_MAX_LENGTH } from "@archestra/shared";
import { Check, Folder, FolderInput, FolderPlus, FolderX } from "lucide-react";
import { Fragment, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useProjects } from "@/lib/projects/projects.query";

export function ConversationProjectActions({
  projectId,
  isPending,
  onProjectChange,
  onCreateProject,
}: {
  projectId: string | null;
  isPending: boolean;
  onProjectChange: (projectId: string | null) => void;
  onCreateProject?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // cmdk highlights the first match only when it filters itself. Results come
  // from the server here, so the first result is highlighted by hand until the
  // user moves the highlight, keeping Enter-to-pick (and Enter-to-create).
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const name = search.trim();
  const debouncedName = useDebouncedValue(name, SEARCH_DEBOUNCE_MS);
  // Asked for only while the submenu is open, and searched by the server:
  // the menu sits on every chat row, and the full list can be large.
  const {
    data: projectsPage,
    isPending: isLoading,
    isPlaceholderData,
  } = useProjects({
    search: debouncedName || undefined,
    limit: MENU_PROJECT_LIMIT,
    offset: 0,
    enabled: open,
  });
  const projects = projectsPage?.data ?? [];
  // Offer creation only once the results answer the name typed, so an
  // existing project of that name is never offered as a new one.
  const settled = !isLoading && !isPlaceholderData && debouncedName === name;
  const canCreate =
    onCreateProject &&
    settled &&
    name.length > 0 &&
    name.length <= PROJECT_NAME_MAX_LENGTH &&
    !projects.some(
      (project) => project.name.toLowerCase() === name.toLowerCase(),
    );

  return (
    <Fragment>
      <DropdownMenuSub open={open} onOpenChange={setOpen}>
        <DropdownMenuSubTrigger disabled={isPending}>
          <FolderInput className="h-4 w-4 mr-2" />
          <span>Change project</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64 p-0">
          <Command
            shouldFilter={false}
            value={
              highlighted ??
              (canCreate ? createValue(name) : (projects[0]?.name ?? ""))
            }
            onValueChange={setHighlighted}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <CommandInput
              placeholder={
                onCreateProject
                  ? "Search or create project..."
                  : "Search projects..."
              }
              value={search}
              onValueChange={(next) => {
                setSearch(next);
                setHighlighted(null);
              }}
              disabled={isPending}
            />
            <CommandList>
              {!canCreate && (
                <CommandEmpty>
                  {!settled ? (
                    <span>Loading projects...</span>
                  ) : onCreateProject && !name && projects.length === 0 ? (
                    <div className="space-y-1 px-3">
                      <p>No projects yet.</p>
                      <p className="text-xs text-muted-foreground">
                        Enter a project name above, then press Enter to create
                        it.
                      </p>
                    </div>
                  ) : (
                    <span>No projects found.</span>
                  )}
                </CommandEmpty>
              )}
              <CommandGroup>
                {projects.map((project) => {
                  const isCurrent = project.id === projectId;
                  return (
                    <CommandItem
                      key={project.id}
                      value={project.name}
                      disabled={isPending}
                      onSelect={() => {
                        if (!isCurrent) onProjectChange(project.id);
                      }}
                    >
                      {project.icon ? (
                        <AgentIcon
                          icon={project.icon}
                          fallbackType="project"
                          size={16}
                        />
                      ) : (
                        <Folder />
                      )}
                      <span className="truncate">{project.name}</span>
                      {isCurrent && <Check className="ml-auto" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {canCreate && (
                <CommandGroup forceMount>
                  <CommandItem
                    value={createValue(name)}
                    forceMount
                    disabled={isPending}
                    onSelect={() => {
                      if (!isPending) onCreateProject(name);
                    }}
                  >
                    <FolderPlus />
                    <span className="truncate">
                      Create project &quot;{name}&quot;
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {projectId && (
        <DropdownMenuItem
          disabled={isPending}
          onSelect={() => onProjectChange(null)}
        >
          <FolderX className="h-4 w-4 mr-2" />
          <span>Remove from project</span>
        </DropdownMenuItem>
      )}
    </Fragment>
  );
}

const createValue = (name: string) => `create-project-${name}`;

const SEARCH_DEBOUNCE_MS = 250;
const MENU_PROJECT_LIMIT = 50;
