"use client";

import { Check, Folder, FolderInput, FolderX } from "lucide-react";
import { Fragment } from "react";
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
}: {
  projectId: string | null;
  projects: Array<{ id: string; name: string; icon: string | null }>;
  isPending: boolean;
  onProjectChange: (projectId: string | null) => void;
}) {
  return (
    <Fragment>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={isPending}>
          <FolderInput className="h-4 w-4 mr-2" />
          <span>Change project</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64 p-0">
          <Command onKeyDown={(event) => event.stopPropagation()}>
            <CommandInput placeholder="Search projects..." />
            <CommandList>
              <CommandEmpty>No projects found.</CommandEmpty>
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
