"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { projectVisibilityToScope } from "@/components/projects/project-visibility";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useResourceOwnershipTransfer } from "@/components/use-resource-ownership-transfer";

// Pin/edit/delete overflow menu shared by the project card and table row.
export function ProjectActionsMenu({
  project,
  pinned,
  canPin,
  canManage,
  canDelete,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  project: archestraApiTypes.GetProjectsResponses["200"][number];
  pinned: boolean;
  canPin: boolean;
  canManage: boolean;
  canDelete: boolean;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const ownership = useResourceOwnershipTransfer({
    kind: "project",
    resource: {
      id: project.id,
      name: project.name,
      authorId: project.createdBy?.id ?? null,
      scope: projectVisibilityToScope(project.visibility),
    },
  });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Project actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canPin && (
            <DropdownMenuItem onSelect={onTogglePin}>
              {pinned ? (
                <PinOff className="h-4 w-4" />
              ) : (
                <Pin className="h-4 w-4" />
              )}
              <span>{pinned ? "Unpin" : "Pin"}</span>
            </DropdownMenuItem>
          )}
          {canManage && (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" />
              Edit details
            </DropdownMenuItem>
          )}
          {ownership.menuItem}
          {canManage && canDelete && (
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {ownership.dialog}
    </>
  );
}
