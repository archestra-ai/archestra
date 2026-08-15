"use client";

import {
  ENVIRONMENT_DEFAULTABLE_RESOURCE_LABELS,
  ENVIRONMENT_DEFAULTABLE_RESOURCES,
  type EnvironmentDefaultableResource,
} from "@archestra/shared";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useEnvironments,
  useUpdateEnvironmentResourceDefaults,
} from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";

// shadcn Select can't use an empty string value, so "no configured default —
// new items land in the org Default environment" gets this sentinel.
const DEFAULT_ENVIRONMENT_VALUE = "__default__";

/**
 * Chooses, per resource kind, which environment newly created items of that
 * kind land in when their creator does not pick one. Unset kinds keep landing
 * in the org Default environment.
 */
export function EnvironmentResourceDefaultsSection({
  canEdit,
}: {
  canEdit: boolean;
}) {
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const resourceDefaults = environmentList?.resourceDefaults;
  const defaultEnvironment = useDefaultEnvironment();
  const updateMutation = useUpdateEnvironmentResourceDefaults();

  // With no environments to choose from every kind can only land in Default,
  // so the whole panel would be a column of disabled selects.
  if (environments.length === 0) return null;

  return (
    <SettingsBlock
      title="Where new resources land"
      description={`Newly created resources are assigned to the environment chosen here unless whoever creates them picks another one. Leave a kind on “${defaultEnvironment.name}” to keep the previous behavior.`}
      control={null}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {ENVIRONMENT_DEFAULTABLE_RESOURCES.map((resource) => (
          <ResourceDefaultRow
            key={resource}
            resource={resource}
            value={resourceDefaults?.[resource] ?? null}
            environments={environments}
            defaultEnvironmentName={defaultEnvironment.name}
            disabled={!canEdit || updateMutation.isPending}
            onChange={(environmentId) =>
              updateMutation.mutate({ [resource]: environmentId })
            }
          />
        ))}
      </div>
    </SettingsBlock>
  );
}

// === Internal helpers ===

function ResourceDefaultRow({
  resource,
  value,
  environments,
  defaultEnvironmentName,
  disabled,
  onChange,
}: {
  resource: EnvironmentDefaultableResource;
  value: string | null;
  environments: { id: string; name: string; restricted: boolean }[];
  defaultEnvironmentName: string;
  disabled: boolean;
  onChange: (environmentId: string | null) => void;
}) {
  const selectId = `environment-default-${resource}`;
  const selected = environments.find((environment) => environment.id === value);

  return (
    <div className="space-y-2">
      <Label htmlFor={selectId}>
        {ENVIRONMENT_DEFAULTABLE_RESOURCE_LABELS[resource]}
      </Label>
      <Select
        value={value ?? DEFAULT_ENVIRONMENT_VALUE}
        disabled={disabled}
        onValueChange={(next) =>
          onChange(next === DEFAULT_ENVIRONMENT_VALUE ? null : next)
        }
      >
        <SelectTrigger id={selectId} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={DEFAULT_ENVIRONMENT_VALUE}>
            {defaultEnvironmentName}
          </SelectItem>
          {environments.map((environment) => (
            <SelectItem key={environment.id} value={environment.id}>
              {environment.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected?.restricted ? (
        <p className="text-xs text-muted-foreground">
          <Badge variant="secondary" className="mr-1.5">
            Restricted
          </Badge>
          Creators without permission to deploy here fall back to{" "}
          {defaultEnvironmentName}.
        </p>
      ) : null}
    </div>
  );
}
