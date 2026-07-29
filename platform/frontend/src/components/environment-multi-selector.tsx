"use client";

import type { Resource } from "@archestra/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { cn } from "@/lib/utils";

interface EnvironmentMultiSelectorProps {
  /** Selected environment ids; empty = available in every environment. */
  value: string[];
  onChange: (environmentIds: string[]) => void;
  /**
   * The RBAC resource being assigned to environments (e.g. "skill").
   * Restricted environments require the resource-specific
   * `deploy-to-restricted` permission.
   */
  resource: Resource;
  /**
   * When set and no custom environments are accessible, render nothing —
   * without environments there is nothing to restrict to.
   */
  hideWhenNoEnvironments?: boolean;
  className?: string;
  /**
   * Short, context-specific explanation of what restricting to environments
   * does here, rendered as muted helper text under the label.
   */
  helpText?: ReactNode;
}

/**
 * Multi-select environment assignment (0..n): unlike {@link EnvironmentSelector}
 * (exactly one environment, null = the org default), an empty selection here
 * means "not restricted — available in every environment".
 */
export function EnvironmentMultiSelector({
  value,
  onChange,
  resource,
  hideWhenNoEnvironments,
  className,
  helpText,
}: EnvironmentMultiSelectorProps) {
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  // Assigning a restricted environment needs the resource-specific
  // deploy-to-restricted permission.
  const { data: hasDeployToRestricted } = useHasPermissions({
    [resource]: ["deploy-to-restricted"],
  });
  // Gates the "Manage environments" link, mirroring the settings page.
  const { data: canManageEnvironments } = useHasPermissions({
    environment: ["update"],
  });
  const canDeployRestricted = hasDeployToRestricted ?? false;
  // Restricted environments the user can't deploy to are hidden, but ones
  // already assigned stay listed so an edit doesn't silently drop them.
  const accessibleEnvironments = environments.filter(
    (environment) =>
      !environment.restricted ||
      canDeployRestricted ||
      value.includes(environment.id),
  );

  if (hideWhenNoEnvironments && accessibleEnvironments.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      <Label>Environments</Label>
      {helpText ? (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      ) : null}
      <MultiSelectCombobox
        options={accessibleEnvironments.map((environment) => ({
          value: environment.id,
          label: environment.name,
        }))}
        value={value}
        onChange={onChange}
        placeholder="All environments"
        emptyMessage="No environments found."
      />
      {canManageEnvironments ? (
        <p className="text-xs text-muted-foreground">
          <Link
            href="/settings/environments"
            className="underline underline-offset-2"
          >
            Manage environments
          </Link>
        </p>
      ) : null}
    </div>
  );
}
