"use client";

import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Pin/edit/delete overflow menu shared by the project card and table row.
export function ProjectActionsMenu({
  pinned,
  canPin,
  canManage,
  canDelete,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  pinned: boolean;
  canPin: boolean;
  canManage: boolean;
  /** Deleting an org-wide project needs `project:share-org` on top of canManage. */
  canDelete: boolean;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
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
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
        )}
        {canManage && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="h-4 w-4" />
            Edit details
          </DropdownMenuItem>
        )}
        {canManage && canDelete && (
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
