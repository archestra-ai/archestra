"use client";

import {
  ENVIRONMENT_DEFAULTABLE_RESOURCE_LABELS,
  ENVIRONMENT_DEFAULTABLE_RESOURCES,
  type EnvironmentDefaultableResource,
} from "@archestra/shared";
import { FormDialog } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
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
 *
 * Each select saves on change rather than on a submit: the rows are
 * independent settings, so there is nothing to validate across them and
 * nothing a Cancel could usefully roll back.
 */
export function EnvironmentResourceDefaultsDialog({
  open,
  onOpenChange,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments ?? [];
  const resourceDefaults = environmentList?.resourceDefaults;
  const defaultEnvironment = useDefaultEnvironment();
  const updateMutation = useUpdateEnvironmentResourceDefaults();

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Where new resources land"
      description={`New resources land in the environment chosen here, unless whoever creates them picks another one. A kind left on “${defaultEnvironment.name}” keeps landing there. Changing a choice never moves resources that already exist.`}
      size="medium"
    >
      <DialogBody>
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
      </DialogBody>
      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogStickyFooter>
    </FormDialog>
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
