"use client";

import Link from "next/link";
import { OpenAppaAlertIcon } from "@/components/openappa-icon";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";

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
 * Sidebar warning: new sessions keep a policy snapshot, so a policy change
 * reaches new sessions only and running sessions keep the revision they have.
 * It links to the setting. Shown wherever the sidebar shows warnings: no
 * navigation row carries it.
 */
export function GuardrailsSnapshotPolicyWarning() {
  const query = useGuardrailsDeployment();
  if (
    !query.data ||
    query.isError ||
    query.data.newSessionPolicy !== "snapshot"
  )
    return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip="Policy changes reach new sessions only"
        className="text-destructive hover:text-destructive"
      >
        <Link href="/settings/guardrails#new-session-policy">
          <OpenAppaAlertIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            New sessions keep a policy snapshot
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
