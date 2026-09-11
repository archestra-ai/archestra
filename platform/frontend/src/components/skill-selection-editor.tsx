"use client";

import { BookOpen, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SkillSelectionItem extends AssignmentComboboxItem {
  id: string;
  name: string;
  chipBadge?: ReactNode;
  removeLabel?: string;
}

interface SkillSelectionEditorProps {
  items: SkillSelectionItem[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  tone?: "assign" | "exclude";
  onSearchChange?: (query: string) => void;
  isSearching?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  testId?: string;
}

/**
 * Shared skill picker used by both MCP publication and internal-agent
 * activation. Source-specific authorization and display rules are projected
 * into `items` by the caller; this component owns only the common interaction.
 */
export function SkillSelectionEditor({
  items,
  selectedIds,
  onSelectionChange,
  tone = "assign",
  onSearchChange,
  isSearching = false,
  placeholder = "Search skills...",
  emptyMessage = "No skills found.",
  testId,
}: SkillSelectionEditorProps) {
  const handleToggle = (skillId: string) => {
    if (selectedIds.includes(skillId)) {
      onSelectionChange(selectedIds.filter((id) => id !== skillId));
    } else {
      onSelectionChange([...selectedIds, skillId]);
    }
  };

  const selectedSkills = items.filter((skill) =>
    selectedIds.includes(skill.id),
  );

  return (
    <div className="flex flex-wrap gap-2">
      {selectedSkills.map((skill) => (
        <div key={skill.id} className="flex items-center">
          <div
            className={cn(
              "flex h-8 max-w-[260px] items-center gap-1.5 rounded-l-md border border-r-0 px-3 text-xs",
            )}
            title={skill.description || skill.name}
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                tone === "exclude" ? "bg-red-500" : "bg-green-500",
              )}
            />
            {skill.icon ?? <BookOpen className="h-3 w-3 shrink-0" />}
            <span className="truncate font-medium">{skill.name}</span>
            {skill.chipBadge && (
              <Badge
                variant="secondary"
                className="max-w-24 shrink truncate px-1.5 py-0 font-normal"
              >
                {skill.chipBadge}
              </Badge>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-7 rounded-l-none p-0 text-muted-foreground hover:text-destructive"
            onClick={() => handleToggle(skill.id)}
            aria-label={skill.removeLabel ?? `Remove ${skill.name}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <AssignmentCombobox
        items={items}
        selectedIds={selectedIds}
        onToggle={handleToggle}
        onSearchChange={onSearchChange}
        isSearching={isSearching}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        testId={testId}
      />
    </div>
  );
}
