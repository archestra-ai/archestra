"use client";

import { cn } from "@/lib/utils";

type AgentPromptDiffProps = {
  basePrompt: string | null;
  baseLabel: string;
  targetPrompt: string | null;
  targetLabel: string;
  className?: string;
};

export function AgentPromptDiff({
  basePrompt,
  baseLabel,
  targetPrompt,
  targetLabel,
  className,
}: AgentPromptDiffProps) {
  const unchanged = basePrompt === targetPrompt;

  return (
    <div className={cn("space-y-3", className)}>
      <PromptBlock label={baseLabel} prompt={basePrompt} accent="muted" />
      {!unchanged && (
        <PromptBlock
          label={targetLabel}
          prompt={targetPrompt}
          accent="active"
        />
      )}
      {unchanged && (
        <p className="text-xs text-muted-foreground text-center py-2">
          No changes — this version matches the current prompt.
        </p>
      )}
    </div>
  );
}

function PromptBlock({
  label,
  prompt,
  accent,
}: {
  label: string;
  prompt: string | null;
  accent: "muted" | "active";
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            accent === "active" ? "bg-primary" : "bg-muted-foreground/40",
          )}
        />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
      </div>
      <pre
        className={cn(
          "whitespace-pre-wrap break-words rounded-md border p-3 text-sm font-mono leading-relaxed min-h-[60px]",
          accent === "active"
            ? "bg-background border-border"
            : "bg-muted/50 border-transparent text-muted-foreground",
        )}
      >
        {prompt ?? (
          <span className="italic opacity-60">No system prompt set</span>
        )}
      </pre>
    </div>
  );
}
