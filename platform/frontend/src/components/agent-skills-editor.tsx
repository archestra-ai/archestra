"use client";

import { BookOpen, X } from "lucide-react";
import {
  type GatewayLike,
  getPersonalSkillPublishWarning,
  getSkillPublishability,
  type SkillLike,
} from "@/components/agent-skills-editor.utils";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface EditableSkill extends SkillLike {
  id: string;
  description?: string | null;
}

interface AgentSkillsEditorProps {
  availableSkills: EditableSkill[];
  selectedSkillIds: string[];
  onSelectionChange: (ids: string[]) => void;
  /**
   * The gateway the skills are being published from, for the environment gate.
   */
  gateway: GatewayLike | null | undefined;
  /**
   * The signed-in user. Personal skills are publishable only by their author,
   * so an unknown user (session still loading) disables them all.
   */
  currentUserId: string | null | undefined;
  /**
   * "assign" picks the set a gateway publishes (Custom mode), so unpublishable
   * skills are shown disabled with the reason. "exclude" only narrows what Auto
   * already publishes, so every offered skill is selectable.
   */
  tone?: "assign" | "exclude";
  /**
   * Notified of the picker's search query so the caller can widen
   * `availableSkills` from the server. Without it the picker can only find what
   * the caller already loaded, which is one page of the catalog.
   */
  onSearchChange?: (query: string) => void;
  /**
   * Whether the caller's widening fetch for the current query is still in
   * flight, so the picker says "searching" rather than "no skills found".
   */
  isSearching?: boolean;
  placeholder?: string;
  testId?: string;
}

export function AgentSkillsEditor({
  availableSkills,
  selectedSkillIds,
  onSelectionChange,
  gateway,
  currentUserId,
  tone = "assign",
  onSearchChange,
  isSearching = false,
  placeholder = "Search skills...",
  testId,
}: AgentSkillsEditorProps) {
  const handleToggle = (skillId: string) => {
    if (selectedSkillIds.includes(skillId)) {
      onSelectionChange(selectedSkillIds.filter((id) => id !== skillId));
    } else {
      onSelectionChange([...selectedSkillIds, skillId]);
    }
  };

  const comboboxItems: AssignmentComboboxItem[] = availableSkills.map(
    (skill) => {
      const { publishable, reason } =
        tone === "assign"
          ? getSkillPublishability({ skill, gateway, currentUserId })
          : { publishable: true, reason: null };
      // A publishable personal skill carries the audience disclosure in its
      // description: publishing serves the body to every token holder, which
      // is wider than the "only I can see this" its scope suggests.
      const warning =
        tone === "assign" && publishable
          ? getPersonalSkillPublishWarning(skill)
          : null;
      return {
        id: skill.id,
        name: skill.name,
        description: warning ?? skill.description ?? undefined,
        // A skill already assigned stays removable even if it has since become
        // unpublishable, so an admin is never stuck with a set they cannot edit.
        disabled: !publishable && !selectedSkillIds.includes(skill.id),
        disabledReason: reason ?? undefined,
        icon: <BookOpen className="h-3.5 w-3.5 shrink-0" />,
      };
    },
  );

  const selectedSkills = availableSkills.filter((skill) =>
    selectedSkillIds.includes(skill.id),
  );

  return (
    <div className="flex flex-wrap gap-2">
      {selectedSkills.map((skill) => (
        <div key={skill.id} className="flex items-center">
          <div
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-l-md border border-r-0 px-3 text-xs max-w-[200px]",
            )}
            title={skill.description || skill.name}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full shrink-0",
                tone === "exclude" ? "bg-red-500" : "bg-green-500",
              )}
            />
            <BookOpen className="h-3 w-3 shrink-0" />
            <span className="font-medium truncate">{skill.name}</span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-7 p-0 rounded-l-none text-muted-foreground hover:text-destructive"
            onClick={() => handleToggle(skill.id)}
            aria-label={`Remove ${skill.name}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <AssignmentCombobox
        items={comboboxItems}
        selectedIds={selectedSkillIds}
        onToggle={handleToggle}
        onSearchChange={onSearchChange}
        isSearching={isSearching}
        placeholder={placeholder}
        emptyMessage="No skills found."
        testId={testId}
      />
    </div>
  );
}
