import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

export function SkillUsageSummary({
  usageCount,
  usageUserCount,
  lastUsedAt,
  onClick,
  label,
}: {
  usageCount: number;
  usageUserCount: number;
  lastUsedAt: string | null;
  onClick?: () => void;
  label?: string;
}) {
  const lastUsed = formatRelativeTimeFromNow(lastUsedAt, {
    neverLabel: "Never used",
  });
  const summary = (
    <span className="inline-flex max-w-full items-center justify-end gap-1.5 whitespace-nowrap tabular-nums">
      <span className="font-medium text-foreground">{usageCount}</span>
      {usageUserCount > 0 && (
        <>
          <span aria-hidden className="text-muted-foreground/60">
            ·
          </span>
          <span className="text-muted-foreground">
            {usageUserCount} {usageUserCount === 1 ? "user" : "users"}
          </span>
        </>
      )}
      <span aria-hidden className="text-muted-foreground/60">
        ·
      </span>
      <span className="truncate text-xs text-muted-foreground" title={lastUsed}>
        {lastUsed}
      </span>
    </span>
  );

  if (!onClick) return summary;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex w-full justify-end rounded px-1.5 py-1 text-sm hover:bg-muted"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {summary}
        </button>
      </TooltipTrigger>
      <TooltipContent>View usage over the last month</TooltipContent>
    </Tooltip>
  );
}
