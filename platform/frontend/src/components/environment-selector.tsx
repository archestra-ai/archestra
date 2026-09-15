"use client";

import { E2eTestId, type Resource } from "@archestra/shared";
import Link from "next/link";
import { type ReactNode, useId } from "react";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
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

export const GLOBAL_ENVIRONMENT_SCOPE = "__global__";
export const GLOBAL_ENVIRONMENT_SCOPE_LABEL = "All environments (default)";

/**
 * Shared environment picker. Assignment modes enforce deployment permissions;
 * defaults and cost scopes configure policy, not resource deployment, so their
 * callers enforce the setting's own edit permission instead.
 */
export function EnvironmentSelector(props: EnvironmentSelectorProps) {
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const defaultEnvironment = useDefaultEnvironment();
  const resource = "resource" in props ? props.resource : undefined;
  const { data: canDeployRestricted } = useHasPermissions(
    resource ? { [resource]: ["deploy-to-restricted"] } : {},
  );
  const { data: canManageEnvironments } = useHasPermissions({
    environment: ["update"],
  });
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const multiple = props.mode === "multiple";
  const scope = props.mode === "scope";
  const label = props.label ?? (multiple ? "Environments" : "Environment");
  const showLabel = props.showLabel ?? !scope;
  const hasCustomEnvironments = environments.length > 0;
  const selectedValues = multiple
    ? props.value
    : [props.value ?? DEFAULT_ENVIRONMENT_VALUE];
  const selectedValue = selectedValues[0];

  if (
    props.hideWhenOnlyDefault &&
    !hasCustomEnvironments &&
    (multiple || selectedValue === DEFAULT_ENVIRONMENT_VALUE)
  )
    return null;

  const fallbackOptions =
    multiple || (scope && !props.includeGlobalOption)
      ? []
      : [
          {
            value: scope ? GLOBAL_ENVIRONMENT_SCOPE : DEFAULT_ENVIRONMENT_VALUE,
            label: scope
              ? GLOBAL_ENVIRONMENT_SCOPE_LABEL
              : defaultEnvironment.name,
            description: scope
              ? "Applies to every environment unless overridden"
              : (defaultEnvironment.description ?? ""),
            restricted: false,
          },
        ];
  const options = [
    ...fallbackOptions,
    ...environments.map((environment) => ({
      value: environment.id,
      label: environment.name,
      description: environment.description ?? "",
      restricted: environment.restricted,
    })),
  ].map((option) => {
    const requiresPermission =
      !!resource && option.restricted && !canDeployRestricted;
    const taken = scope && props.takenValues?.has(option.value);
    return {
      ...option,
      disabled: requiresPermission || !!taken,
      description: requiresPermission ? (
        <RestrictedEnvironmentDescription
          permission={`${resource}:deploy-to-restricted`}
          selected={selectedValues.includes(option.value)}
        />
      ) : taken ? (
        (props.takenReason ?? "Already has a limit")
      ) : (
        option.description
      ),
    };
  });
  const selectedOption = options.find(
    (option) => option.value === selectedValue,
  );
  // Permission explanations belong in the menu; keep the field's contextual
  // description independent from whether its current option can be reassigned.
  const selectedDescription =
    !multiple && !scope && props.mode !== "default"
      ? selectedValue === DEFAULT_ENVIRONMENT_VALUE
        ? defaultEnvironment.description
        : environments.find((environment) => environment.id === selectedValue)
            ?.description
      : null;

  return (
    <div className={cn("grid min-w-0 content-start gap-2", props.className)}>
      {showLabel && <Label htmlFor={id}>{label}</Label>}
      {props.helpText && props.mode !== "default" ? (
        <FieldDescription>{props.helpText}</FieldDescription>
      ) : null}
      {selectedDescription ? (
        <FieldDescription>{selectedDescription}</FieldDescription>
      ) : null}
      {!hasCustomEnvironments &&
      !scope &&
      !multiple &&
      props.mode !== "default" ? (
        <FieldDescription>
          Only the default environment is available.
          {canManageEnvironments ? (
            <>
              <span> </span>
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
      {props.mode === "multiple" ? (
        <MultiSelectCombobox
          id={id}
          ariaLabel={label}
          options={options}
          value={props.value}
          onChange={props.onChange}
          placeholder="All environments"
          emptyMessage="No environments found."
          disabled={props.disabled}
        />
      ) : (
        <Select
          value={
            scope
              ? props.value || undefined
              : (props.value ?? DEFAULT_ENVIRONMENT_VALUE)
          }
          disabled={
            props.disabled ||
            (!hasCustomEnvironments &&
              props.mode !== "scope" &&
              props.mode !== "default" &&
              selectedValue === DEFAULT_ENVIRONMENT_VALUE)
          }
          onValueChange={(next) => {
            // Radix's hidden native select may emit an empty value while a form
            // initializes before its options. No mode offers an empty-string
            // selection; Default and global scope use non-empty sentinels.
            if (next === "") return;
            if (props.mode === "scope") props.onChange(next);
            else
              props.onChange(next === DEFAULT_ENVIRONMENT_VALUE ? null : next);
          }}
        >
          <SelectTrigger
            id={id}
            aria-label={label}
            className="min-w-0 w-full"
            data-testid={E2eTestId.SelectEnvironment}
          >
            <SelectValue
              placeholder={
                scope ? (props.placeholder ?? "Select environment") : undefined
              }
            >
              {selectedOption ? (
                <span className="truncate">{selectedOption.label}</span>
              ) : null}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            position="popper"
            className="max-w-[var(--radix-select-trigger-width)]"
          >
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                description={option.description || undefined}
                className="items-start [&>div]:min-w-0 [&>div]:break-words"
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {props.helpText && props.mode === "default" ? (
        <FieldDescription>{props.helpText}</FieldDescription>
      ) : null}
    </div>
  );
}

// === Internal helpers ===

type CommonProps = {
  id?: string;
  label?: string;
  showLabel?: boolean;
  className?: string;
  helpText?: ReactNode;
  disabled?: boolean;
  hideWhenOnlyDefault?: boolean;
};
type EnvironmentSelectorProps = CommonProps &
  (
    | {
        mode?: "assignment";
        resource: Resource;
        value: string | null;
        onChange: (value: string | null) => void;
      }
    | {
        mode: "multiple";
        resource: Resource;
        value: string[];
        onChange: (value: string[]) => void;
      }
    | {
        mode: "default";
        value: string | null;
        onChange: (value: string | null) => void;
      }
    | {
        mode: "scope";
        value: string;
        onChange: (value: string) => void;
        includeGlobalOption?: boolean;
        takenValues?: ReadonlySet<string>;
        takenReason?: string;
        placeholder?: string;
      }
  );

function RestrictedEnvironmentDescription({
  permission,
  selected,
}: {
  permission: string;
  selected: boolean;
}) {
  return (
    <>
      <span>
        {selected
          ? "You can keep this assignment. New assignments require "
          : "You need "}
      </span>
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">
        {permission}
      </code>
      <span>
        {selected
          ? " permission."
          : " permission to assign resources to this environment."}
      </span>
    </>
  );
}

const DEFAULT_ENVIRONMENT_VALUE = "__default__";
