"use client";

import {
  ENVIRONMENT_DEFAULTABLE_RESOURCE_LABELS,
  ENVIRONMENT_DEFAULTABLE_RESOURCES,
  type EnvironmentDefaultableResource,
} from "@archestra/shared";
import { EnvironmentSelector } from "@/components/environment-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import {
  useEnvironments,
  useUpdateEnvironmentResourceDefaults,
} from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";

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
    <EnvironmentSelector
      mode="default"
      id={selectId}
      label={ENVIRONMENT_DEFAULTABLE_RESOURCE_LABELS[resource]}
      value={value}
      onChange={onChange}
      disabled={disabled}
      helpText={
        selected?.restricted ? (
          <span>
            Creators without{" "}
            <code className="inline-block max-w-full rounded bg-muted px-1 py-0.5 font-mono text-xs break-all align-baseline">
              {resource}:deploy-to-restricted
            </code>{" "}
            permission fall back to {defaultEnvironmentName}.
          </span>
        ) : undefined
      }
    />
  );
}
