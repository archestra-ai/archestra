"use client";

import Link from "next/link";
import { OpenAppaAlertIcon } from "@/components/openappa-icon";
import { Label } from "@/components/ui/label";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useGuardrailsDeployment,
  useUpdateGuardrailsDeployment,
} from "@/lib/guardrails-deployment.query";

/**
 * Sidebar warning: the deployment has Guardrails but enforcement is off, so
 * tool calls run unchecked. It links to the Guardrails page, where an
 * administrator turns it on.
 *
 * Nothing renders while enforcement is on. A row that only ever reports that
 * things are fine is a row the reader stops reading, which costs the warning
 * the attention it exists for. Shown where the navigation has no Guardrails
 * row of its own to carry the same warning.
 */
export function GuardrailsDisabledWarning() {
  const query = useGuardrailsDeployment();
  if (!query.data || query.isError || query.data.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip="Guardrails enforcement is off"
        className="text-destructive hover:text-destructive"
      >
        <Link href="/openappa">
          <OpenAppaAlertIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Guardrails disabled</span>
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
