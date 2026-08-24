import { Button } from "@/components/ui/button";
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
  const usesLabel = `${usageCount} ${usageCount === 1 ? "use" : "uses"}`;
  const usersLabel =
    usageUserCount > 0
      ? `${usageUserCount} ${usageUserCount === 1 ? "user" : "users"}`
      : null;
  const activityLabel = usersLabel
    ? `${usesLabel}, ${usersLabel}, ${lastUsed}`
    : `${usesLabel}, ${lastUsed}`;
  const count = (
    <span className="font-medium tabular-nums text-foreground">
      {usageCount}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick ? (
          <Button
            type="button"
            variant="ghost"
            className="h-7 w-full justify-end px-1.5"
            aria-label={label ? `${label}: ${activityLabel}` : activityLabel}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            {count}
          </Button>
        ) : (
          <span className="flex h-7 w-full items-center justify-end px-1.5">
            <span className="sr-only">{activityLabel}</span>
            <span aria-hidden>{count}</span>
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent className="space-y-0.5">
        <p className="font-medium">{usesLabel}</p>
        <p className="text-xs text-muted-foreground">
          {usersLabel ? `${usersLabel} · ${lastUsed}` : lastUsed}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
