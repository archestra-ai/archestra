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

export function ConversationProjectActions({
  projectId,
  projects,
  isPending,
  onProjectChange,
  onCreateProject,
}: {
  projectId: string | null;
  projects: Array<{ id: string; name: string; icon: string | null }>;
  isPending: boolean;
  onProjectChange: (projectId: string | null) => void;
  onCreateProject?: (name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const name = search.trim();
  const canCreate =
    onCreateProject &&
    name.length > 0 &&
    name.length <= PROJECT_NAME_MAX_LENGTH &&
    !projects.some(
      (project) => project.name.toLowerCase() === name.toLowerCase(),
    );

  return (
    <Fragment>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={isPending}>
          <FolderInput className="h-4 w-4 mr-2" />
          <span>Change project</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64 p-0">
          <Command onKeyDown={(event) => event.stopPropagation()}>
            <CommandInput
              placeholder={
                onCreateProject
                  ? "Search or create project..."
                  : "Search projects..."
              }
              value={search}
              onValueChange={setSearch}
              disabled={isPending}
            />
            <CommandList>
              {!canCreate && (
                <CommandEmpty>
                  <span>
                    {onCreateProject && !name
                      ? "Type a name to create a project."
                      : "No projects found."}
                  </span>
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
                    value={`create-project-${name}`}
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
