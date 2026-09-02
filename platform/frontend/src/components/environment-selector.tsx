"use client";

import { E2eTestId, type Resource } from "@archestra/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { cn } from "@/lib/utils";

// shadcn Select can't use an empty string value, so the org default (a null
// environmentId) is represented by this sentinel internally.
const DEFAULT_ENVIRONMENT_VALUE = "__default__";

interface EnvironmentSelectorProps {
  /** Selected environment id; null selects the org default. */
  value: string | null;
  onChange: (environmentId: string | null) => void;
  /**
   * The RBAC resource being assigned to the environment (e.g. "agent",
   * "llmProxy", "mcpRegistry"). Restricted environments require the
   * resource-specific `deploy-to-restricted` permission.
   */
  resource: Resource;
  /**
   * When set and no custom environments are accessible, render nothing instead
   * of a disabled default-only select (the agent dialog hides the field in that
   * case; the MCP form shows the disabled state).
   */
  hideWhenOnlyDefault?: boolean;
  /**
   * Off where the host already names the field — a settings surface puts the
   * title in its own label column, and a second one here would say it twice.
   * The select keeps its `aria-label` either way.
   */
  showLabel?: boolean;
  /** Applied to the field's root element, e.g. a card wrapper for the agent dialog. */
  className?: string;
  /**
   * Short, context-specific explanation of what assigning an environment does
   * here (the meaning differs for agents vs. LLM proxies vs. knowledge bases),
   * rendered as muted helper text under the label.
   */
  helpText?: ReactNode;
  /** Render the current value for orientation without letting it change. */
  disabled?: boolean;
}

export function EnvironmentSelector({
  value,
  onChange,
  resource,
  hideWhenOnlyDefault,
  showLabel = true,
  className,
  helpText,
  disabled,
}: EnvironmentSelectorProps) {
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultEnvironment = useDefaultEnvironment();
  // Deploying to a restricted environment needs the resource-specific
  // deploy-to-restricted permission.
  const { data: hasDeployToRestricted } = useHasPermissions({
    [resource]: ["deploy-to-restricted"],
  });
  // Gates the "Manage environments" link, mirroring the settings page.
  const { data: canManageEnvironments } = useHasPermissions({
    environment: ["update"],
  });
  const canDeployRestricted = hasDeployToRestricted ?? false;
  // Restricted environments the user can't deploy to are hidden entirely; the
  // default is always available.
  const accessibleEnvironments = environments.filter(
    (environment) => !environment.restricted || canDeployRestricted,
  );
  const hasCustomEnvironmentOptions = accessibleEnvironments.length > 0;

  if (hideWhenOnlyDefault && !hasCustomEnvironmentOptions) return null;

  const options = [
    {
      value: DEFAULT_ENVIRONMENT_VALUE,
      label: defaultEnvironment.name,
      description: defaultEnvironment.description ?? "",
    },
    ...accessibleEnvironments.map((environment) => ({
      value: environment.id,
      label: environment.name,
      description: environment.description ?? "",
    })),
  ];
  const selectedValue = value ?? DEFAULT_ENVIRONMENT_VALUE;
  const selectedDescription = options.find(
    (option) => option.value === selectedValue,
  )?.description;

  return (
    <div className={cn("grid gap-2", className)}>
      {showLabel && <Label>Environment</Label>}
      {(helpText || selectedDescription || !hasCustomEnvironmentOptions) && (
        <div className="space-y-1">
          {helpText ? <FieldDescription>{helpText}</FieldDescription> : null}
          {selectedDescription ? (
            <FieldDescription>{selectedDescription}</FieldDescription>
          ) : null}
          {!hasCustomEnvironmentOptions ? (
            <FieldDescription>
              Only the default environment is available.
              {canManageEnvironments ? (
                <>
                  {" "}
                  <Link
                    href="/settings/environments"
                    className="underline underline-offset-2"
                  >
                    Manage environments
                  </Link>
                </>
              ) : null}
            </FieldDescription>
          ) : null}
        </div>
      )}
      <Select
        value={selectedValue}
        disabled={disabled || !hasCustomEnvironmentOptions}
        onValueChange={(next) =>
          onChange(next === DEFAULT_ENVIRONMENT_VALUE ? null : next)
        }
      >
        <SelectTrigger
          aria-label="Environment"
          className="w-full"
          data-testid={E2eTestId.SelectEnvironment}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              description={option.description || undefined}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
