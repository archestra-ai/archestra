"use client";

import { E2eTestId } from "@archestra/shared";
import { X } from "lucide-react";
import { KnowledgeSourceIcon } from "@/components/knowledge-source-icon";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";

/** The subset of a knowledge connector this editor names and disables. */
export interface KnowledgeSourceOption {
  id: string;
  name: string;
  connectorType?: string | null;
  description?: string | null;
}

/**
 * Auto-mode knowledge-source exclusions: the sources kept out of an agent's
 * knowledge search while it reaches everything its caller can. The knowledge
 * counterpart of the "Disabled tools" editor, and shaped like the disabled-
 * subagents one rather than that one — a knowledge source has no sub-items to
 * narrow, so a pill is a name and a way to re-enable it.
 *
 * `selectedIds` may name a source this list does not carry (one deleted, or
 * left behind in another environment). Those stay in the caller's state so a
 * save cannot silently drop them, and are not rendered: there is nothing
 * truthful to name them with, and they are inert either way.
 */
export function KnowledgeSourceExclusionsEditor({
  sources,
  selectedIds,
  onSelectionChange,
  placeholder = "Search knowledge sources...",
}: {
  sources: KnowledgeSourceOption[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  placeholder?: string;
}) {
  const handleToggle = (id: string) => {
    onSelectionChange(
      selectedIds.includes(id)
        ? selectedIds.filter((selected) => selected !== id)
        : [...selectedIds, id],
    );
  };

  const comboboxItems: AssignmentComboboxItem[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    description: source.description || undefined,
    icon: <KnowledgeSourceIcon connectorType={source.connectorType} />,
  }));

  const selectedSources = sources.filter((source) =>
    selectedIds.includes(source.id),
  );

  return (
    <div
      className="flex flex-wrap gap-2"
      data-testid={E2eTestId.AgentKnowledgeSourceExclusions}
    >
      {selectedSources.map((source) => (
        <div key={source.id} className="flex items-center">
          <span
            className="flex h-8 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md rounded-r-none border border-r-0 px-3 text-xs"
            data-testid={E2eTestId.AgentKnowledgeSourceExclusionPill}
          >
            <span className="size-2 shrink-0 rounded-full bg-red-500" />
            <KnowledgeSourceIcon connectorType={source.connectorType} />
            <span className="min-w-0 truncate font-medium">{source.name}</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-7 rounded-l-none p-0 text-muted-foreground hover:text-destructive"
            onClick={() => handleToggle(source.id)}
            aria-label={`Re-enable ${source.name}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <AssignmentCombobox
        items={comboboxItems}
        selectedIds={selectedIds}
        onToggle={handleToggle}
        testId={E2eTestId.AgentKnowledgeSourceExclusionsCombobox}
        label="Disable"
        placeholder={placeholder}
        emptyMessage="No knowledge sources found."
      />
    </div>
  );
}
