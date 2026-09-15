"use client";

import { BookOpen, X } from "lucide-react";
import { useState } from "react";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";
import { ExpandableText } from "@/components/ui/expandable-text";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface SkillSelectionItem extends AssignmentComboboxItem {
  id: string;
  name: string;
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
        <SkillPill
          key={skill.id}
          skill={skill}
          tone={tone}
          onRemove={() => handleToggle(skill.id)}
        />
      ))}
      <AssignmentCombobox
        items={items}
        selectedIds={selectedIds}
        onToggle={handleToggle}
        label={tone === "exclude" ? "Disable Skill" : undefined}
        onSearchChange={onSearchChange}
        isSearching={isSearching}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        testId={testId}
      />
    </div>
  );
}

interface SkillPillProps {
  skill: SkillSelectionItem;
  tone: "assign" | "exclude";
  onRemove: () => void;
}

/** A selected skill's chip, with a popover of its details — the skill
 * counterpart of `SubagentPill` in `agent-form.tsx`, reusing the same
 * trigger/content shape so both dropdowns behave identically. */
function SkillPill({ skill, tone, onRemove }: SkillPillProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <div className="flex items-center">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 max-w-[260px] gap-1.5 rounded-r-none border-r-0 px-3 text-xs"
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                tone === "exclude" ? "bg-red-500" : "bg-green-500",
              )}
            />
            {skill.icon ?? <BookOpen className="h-3 w-3 shrink-0" />}
            <span className="truncate font-medium">{skill.name}</span>
          </Button>
        </PopoverTrigger>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-7 rounded-l-none p-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={skill.removeLabel ?? `Remove ${skill.name}`}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <PopoverContent
        className="w-[350px] p-0"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
      >
        <div className="flex items-start justify-between gap-2 border-b p-4">
          <div className="min-w-0 flex-1">
            <h4 className="truncate font-semibold">{skill.name}</h4>
            {skill.description && (
              <ExpandableText
                text={skill.description}
                maxLines={2}
                className="mt-1 text-sm text-muted-foreground"
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {(skill.badge || skill.disabledReason) && (
          <div className="space-y-1.5 p-4 text-sm">
            {skill.badge && (
              <p className="text-muted-foreground">{skill.badge}</p>
            )}
            {skill.disabledReason && (
              <p className="text-destructive">{skill.disabledReason}</p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
