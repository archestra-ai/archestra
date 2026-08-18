"use client";

import { ChevronDown, LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type BatchAnalysisTemplate,
  useBatchAnalysisTemplates,
} from "@/lib/batch-analysis/batch-analysis.query";

/**
 * A dropdown of predefined column sets. Picking is an action, not a value —
 * the wizard replaces its draft columns with the pick, the edit dialog
 * appends — so a menu (repeatable, stateless) fits better than a Select.
 */
export function TemplatePicker({
  onPick,
}: {
  onPick: (template: BatchAnalysisTemplate) => void;
}) {
  const { data: templates = [] } = useBatchAnalysisTemplates();
  if (templates.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
          <span>Choose a template</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 w-96 overflow-y-auto"
      >
        {templates.map((template) => (
          <DropdownMenuItem
            key={template.id}
            className="flex-col items-start gap-0.5"
            onSelect={() => onPick(template)}
          >
            <span className="font-medium text-sm">{template.name}</span>
            <span className="line-clamp-2 text-muted-foreground text-xs">
              {template.description} · {template.columns.length} columns
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
