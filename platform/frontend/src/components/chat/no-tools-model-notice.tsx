import { InfoIcon } from "lucide-react";

/**
 * Shown above the composer when the selected model can't take tools while the
 * selected agent has some: the turn runs tool-less (the backend omits tools
 * for such models), which the user should learn before sending, not from
 * tools silently never firing.
 */
export function NoToolsModelNotice() {
  return (
    <p className="flex items-center justify-center gap-1.5 px-2 text-xs text-muted-foreground">
      <InfoIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        The selected model doesn&apos;t support tools, so this agent&apos;s
        tools won&apos;t be used in this chat. Switch models to use tools.
      </span>
    </p>
  );
}
