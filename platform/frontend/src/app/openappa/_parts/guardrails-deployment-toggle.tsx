"use client";

import Link from "next/link";
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
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
import { cn } from "@/lib/utils";

/**
 * OpenAPPA is off and its policy was never saved, so it was never set up: an
 * administrator's way in is the setup wizard rather than the switch or the
 * empty OpenAPPA page.
 */
export function useOpenAppaNeedsSetup(): boolean | undefined {
  const query = useGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  const candidate = Boolean(
    canManage && query.data?.enabled === false && query.data.featureEnabled,
  );
  const policy = useGuardrailsPolicy({ enabled: candidate });
  if (!candidate) return false;
  // Unknown until the policy answers; a failed read falls back to the switch.
  if (!policy.data) return policy.isError ? false : undefined;
  return policy.data.revision === 0;
}

export function GuardrailsDeploymentToggle() {
  const query = useGuardrailsDeployment();
  const update = useUpdateGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  const needsSetup = useOpenAppaNeedsSetup();
  // Waiting on the policy keeps the switch from showing before the setup link.
  if (!query.data || query.isError || needsSetup === undefined) return null;
  const { enabled, featureEnabled } = query.data;
  if (needsSetup)
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          className="text-destructive hover:text-destructive"
        >
          <Link href="/openappa/setup">
            <OpenAppaAlertIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Set up OpenAPPA</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
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
