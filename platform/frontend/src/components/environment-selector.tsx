"use client";

import { E2eTestId } from "@archestra/shared";
import Link from "next/link";
import type { ReactNode } from "react";
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
   * When set and no custom environments are accessible, render nothing instead
   * of a disabled default-only select (the agent dialog hides the field in that
   * case; the MCP form shows the disabled state).
   */
  hideWhenOnlyDefault?: boolean;
  /** Applied to the field's root element, e.g. a card wrapper for the agent dialog. */
  className?: string;
  /**
   * Short, context-specific explanation of what assigning an environment does
   * here (the meaning differs for agents vs. LLM proxies vs. knowledge bases),
   * rendered as muted helper text under the label.
   */
  helpText?: ReactNode;
}

export function EnvironmentSelector({
  value,
  onChange,
  hideWhenOnlyDefault,
  className,
  helpText,
}: EnvironmentSelectorProps) {
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultEnvironment = useDefaultEnvironment();
  // Deploying to a restricted environment needs environment:deploy-to-restricted;
  // environment:admin (full environment management) implies it.
  const { data: hasEnvAdmin } = useHasPermissions({ environment: ["admin"] });
  const { data: hasDeployToRestricted } = useHasPermissions({
    environment: ["deploy-to-restricted"],
  });
  const canDeployRestricted =
    (hasEnvAdmin ?? false) || (hasDeployToRestricted ?? false);
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
    <div className={cn("space-y-2", className)}>
      <Label>Environment</Label>
      {helpText ? (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      ) : null}
      <Select
        value={selectedValue}
        disabled={!hasCustomEnvironmentOptions}
        onValueChange={(next) =>
          onChange(next === DEFAULT_ENVIRONMENT_VALUE ? null : next)
        }
      >
        <SelectTrigger
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
      {selectedDescription ? (
        <p className="text-xs text-muted-foreground">{selectedDescription}</p>
      ) : null}
      {!hasCustomEnvironmentOptions ? (
        <p className="text-xs text-muted-foreground">
          Only the default environment is available.
          {hasEnvAdmin ? (
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
        </p>
      ) : null}
    </div>
  );
}
