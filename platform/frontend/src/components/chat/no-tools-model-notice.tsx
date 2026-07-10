import { InfoIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Shown above the composer when the selected model can't take tools while the
 * selected agent has some: the turn runs tool-less (the backend omits tools
 * for such models), which the user should learn before sending, not from
 * tools silently never firing.
 */
export function NoToolsModelNotice() {
  return (
    <Alert variant="info">
      <InfoIcon />
      <AlertDescription className="text-sm">
        The selected model doesn&apos;t support tools, so this agent&apos;s
        tools won&apos;t be used in this chat. Switch models to use tools.
      </AlertDescription>
    </Alert>
  );
}
