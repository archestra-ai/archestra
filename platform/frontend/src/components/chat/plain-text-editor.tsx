"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * The shared textarea editor shell: a controlled textarea with a count/limit
 * footer and Cancel/Save. The counting policy stays with the caller (project
 * instructions count characters; the file editor counts UTF-8 bytes), passed in
 * as `count`/`max`, so this stays a pure presentational component. Save is
 * disabled while saving or over the limit. Used by both the project-instructions
 * editor and the Files-panel text editor so they behave identically.
 */
export function PlainTextEditor({
  value,
  onChange,
  count,
  max,
  saving,
  onSave,
  onCancel,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  count: number;
  max: number;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const overLimit = count > max;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder || "Text editor"}
        className="min-h-40 flex-1 resize-none font-mono text-xs"
        autoFocus
      />
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-[11px]",
            overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {count.toLocaleString()} / {max.toLocaleString()}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onSave}
            disabled={saving || overLimit}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
