"use client";

import {
  OpenAppaAlertIcon,
  OpenAppaSolidIcon,
} from "@/components/openappa-icon";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useGuardrailsDeployment,
  useUpdateGuardrailsDeployment,
} from "@/lib/guardrails-deployment.query";
import { cn } from "@/lib/utils/tailwind";

export function GuardrailsDeploymentToggle() {
  const query = useGuardrailsDeployment();
  const update = useUpdateGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  if (!query.data || query.isError) return null;
  const { enabled, featureEnabled } = query.data;
  const canToggle = Boolean(canManage && featureEnabled && !update.isPending);
  const action = enabled ? "Disable OpenAPPA" : "Enable OpenAPPA";
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            role="switch"
            aria-label={`OpenAPPA is ${enabled ? "enabled" : "disabled"}`}
            aria-checked={enabled}
            disabled={!canToggle}
            onClick={() => update.mutate(!enabled)}
            className={cn(
              !enabled && "text-destructive hover:text-destructive",
            )}
          >
            {enabled ? (
              <OpenAppaSolidIcon className="size-4 shrink-0" />
            ) : (
              <OpenAppaAlertIcon className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              OpenAPPA {enabled ? "enabled" : "disabled"}
            </span>
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right">
          {canToggle
            ? action
            : "Only administrators can change OpenAPPA enforcement"}
        </TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
}
