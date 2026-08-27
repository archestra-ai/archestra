"use client";

import { X } from "lucide-react";
import { KnowledgeSourceIcon } from "@/components/knowledge-source-icon";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The subset of a knowledge source this editor names and toggles. */
export interface KnowledgeSourceOption {
  id: string;
  name: string;
  connectorType?: string | null;
  description?: string | null;
  /** Kind marker shown in the dropdown, e.g. "Knowledge base". */
  badge?: string;
  /** Unselectable, with `disabledReason` saying why (another environment). */
  disabled?: boolean;
  disabledReason?: string;
}

interface KnowledgeSourcesEditorProps {
  sources: KnowledgeSourceOption[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  /**
   * What being listed means. "assign" is the Custom-mode set the agent may
   * search; "exclude" is the Auto-mode set it may not. Only the pill's dot and
   * the trigger's wording differ — the two are the same field inversed, and
   * they are meant to look it.
   */
  tone: "assign" | "exclude";
  label: string;
  placeholder?: string;
  emptyMessage?: string;
  createAction?: { label: string; href: string };
  testIds: { container: string; pill: string; combobox: string };
}

/**
 * The knowledge half of an agent's Tools & Knowledge step, in both modes: the
 * sources it may search (Custom) and the sources it may not (Auto). Shaped like
 * the tool and subagent editors beside it — a pill per named source, and one
 * combobox to name another.
 *
 * `selectedIds` may name a source this list does not carry (one deleted, or
 * left behind in another environment). Those stay in the caller's state so a
 * save cannot silently drop them, and are not rendered: there is nothing
 * truthful to name them with, and they are inert either way.
 */
export function KnowledgeSourcesEditor({
  sources,
  selectedIds,
  onToggle,
  tone,
  label,
  placeholder = "Search knowledge sources...",
  emptyMessage = "No knowledge sources found.",
  createAction,
  testIds,
}: KnowledgeSourcesEditorProps) {
  const comboboxItems: AssignmentComboboxItem[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    description: source.description || undefined,
    badge: source.badge,
    disabled: source.disabled,
    disabledReason: source.disabledReason,
    icon: <KnowledgeSourceIcon connectorType={source.connectorType} />,
  }));

  const selectedSources = sources.filter((source) =>
    selectedIds.includes(source.id),
  );

  return (
    <div className="flex flex-wrap gap-2" data-testid={testIds.container}>
      {selectedSources.map((source) => (
        <div key={source.id} className="flex items-center">
          <span
            className="flex h-8 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md rounded-r-none border border-r-0 px-3 text-xs"
            data-testid={testIds.pill}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                tone === "exclude" ? "bg-red-500" : "bg-green-500",
              )}
            />
            <KnowledgeSourceIcon connectorType={source.connectorType} />
            <span className="min-w-0 truncate font-medium">{source.name}</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-7 rounded-l-none p-0 text-muted-foreground hover:text-destructive"
            onClick={() => onToggle(source.id)}
            aria-label={
              tone === "exclude"
                ? `Re-enable ${source.name}`
                : `Remove ${source.name}`
            }
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <AssignmentCombobox
        items={comboboxItems}
        selectedIds={selectedIds}
        onToggle={onToggle}
        testId={testIds.combobox}
        label={label}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        createAction={createAction}
      />
    </div>
  );
}
