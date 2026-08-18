"use client";

import { LayoutTemplate } from "lucide-react";
import {
  type BatchAnalysisTemplate,
  useBatchAnalysisTemplates,
} from "@/lib/batch-analysis/batch-analysis.query";

/**
 * A strip of predefined column sets. Selection only hands the template to the
 * caller — the wizard replaces its draft columns with it, the edit dialog
 * appends — so the picker itself stays stateless.
 */
export function TemplatePicker({
  onPick,
  compact,
}: {
  onPick: (template: BatchAnalysisTemplate) => void;
  /** Single-row scroll strip for dialogs rather than the two-column grid. */
  compact?: boolean;
}) {
  const { data: templates = [] } = useBatchAnalysisTemplates();
  if (templates.length === 0) return null;

  return (
    <div
      className={
        compact
          ? "flex gap-2 overflow-x-auto pb-1"
          : "grid grid-cols-1 gap-2 sm:grid-cols-2"
      }
    >
      {templates.map((template) => (
        <button
          key={template.id}
          type="button"
          className={`flex items-start gap-2.5 rounded-md border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent ${
            compact ? "min-w-56 shrink-0" : ""
          }`}
          onClick={() => onPick(template)}
        >
          <LayoutTemplate className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block font-medium text-sm">{template.name}</span>
            <span className="line-clamp-2 block text-muted-foreground text-xs">
              {template.description} · {template.columns.length} columns
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
