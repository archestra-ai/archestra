import { CheckCircle2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Selectable tile for choosing a connection/reachability mode in trigger
 * setup steps (MS Teams, Slack).
 */
export function ModeTile({
  selected,
  onSelect,
  icon: Icon,
  title,
  badge,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: LucideIcon;
  title: string;
  badge?: string;
  description: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-input hover:bg-accent/50",
      )}
    >
      <span className="flex w-full items-start justify-between gap-2 text-sm font-medium text-foreground">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          {title}
          {badge && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </span>
        {selected && (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
        )}
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}
