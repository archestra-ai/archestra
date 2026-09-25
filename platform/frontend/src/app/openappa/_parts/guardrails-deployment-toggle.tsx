"use client";

import Link from "next/link";
import {
  OpenAppaAlertIcon,
  OpenAppaSolidIcon,
} from "@/components/openappa-icon";
import { Label } from "@/components/ui/label";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useGuardrailsDeployment,
  useUpdateGuardrailsDeployment,
} from "@/lib/guardrails-deployment.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Sidebar status: whether OpenAPPA enforcement is on, linking to the Policy
 * page where an administrator switches it.
 */
export function GuardrailsDeploymentToggle() {
  const query = useGuardrailsDeployment();
  if (!query.data || query.isError) return null;
  const { enabled } = query.data;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={`OpenAPPA enforcement is ${enabled ? "on" : "off"}`}
        className={cn(!enabled && "text-destructive hover:text-destructive")}
      >
        <Link href="/openappa/policy">
          {enabled ? (
            <OpenAppaSolidIcon className="size-4 shrink-0" />
          ) : (
            <OpenAppaAlertIcon className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            OpenAPPA {enabled ? "on" : "off"}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The enforcement section on the Policy page. Turning it off is the way out of
 * a policy that locks agents out.
 */
export function EnforcementSwitch() {
  const query = useGuardrailsDeployment();
  const update = useUpdateGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  if (!query.data || query.isError) return null;
  const { enabled, featureEnabled } = query.data;
  return (
    <section className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-0.5">
        <Label htmlFor="openappa-enforcement" className="text-sm font-medium">
          Enforcement
        </Label>
        <p className="text-sm text-muted-foreground">
          {enabled ? (
            <span>
              Every tool call is checked against this policy before it runs.
              Turn it off if the policy locks agents out.
            </span>
          ) : (
            <span>
              Tool calls run without policy checks. Turn it on to apply this
              policy.
            </span>
          )}{" "}
          {!canManage && (
            <span>Only administrators can turn enforcement on or off.</span>
          )}
        </p>
      </div>
      <Switch
        id="openappa-enforcement"
        checked={enabled}
        disabled={!canManage || !featureEnabled || update.isPending}
        onCheckedChange={(checked) => update.mutate(checked)}
      />
    </section>
  );
}
