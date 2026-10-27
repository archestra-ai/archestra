"use client";

import { useEffect, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import {
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  type LimitCleanupInterval,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type DefaultUserLimit,
  useCreateDefaultUserLimit,
  useDeleteDefaultUserLimit,
  useUpdateDefaultUserLimit,
} from "@/lib/default-user-limit.query";
import { useLlmModelOptions } from "@/lib/llm-models.query";
import {
  formatLimit,
  intervalLabel,
  modelCountLabel,
} from "./user-limits-shared";

type Environment = { id: string; name: string };

/**
 * Add or edit a default user limit. The dialog adapts to what it is for:
 * - the organization default (`initialEnvironmentId: null`, or editing the
 *   organization row): no environment field at all;
 * - an environment override (`initialEnvironmentId` an environment id or
 *   `undefined`, or editing an override): environment first and required,
 *   with environments that already have an override grouped and disabled.
 */
export function DefaultLimitDialog({
  open,
  onOpenChange,
  editing,
  initialEnvironmentId,
  defaults,
  environments,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: DefaultUserLimit | null;
  initialEnvironmentId?: string | null;
  defaults: DefaultUserLimit[];
  environments: Environment[];
  onSaved?: (environmentId: string | null) => void;
}) {
  const { data: modelOptions = [] } = useLlmModelOptions();
  const createDefault = useCreateDefaultUserLimit();
  const updateDefault = useUpdateDefaultUserLimit();

  const isOrganization = editing
    ? editing.environmentId === null
    : initialEnvironmentId === null;
  const orgDefault = defaults.find((d) => d.environmentId === null);

  const [environmentId, setEnvironmentId] = useState("");
  const [limitValue, setLimitValue] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [isAllModels, setIsAllModels] = useState(true);
  const [cleanupInterval, setCleanupInterval] = useState<LimitCleanupInterval>(
    DEFAULT_LIMIT_CLEANUP_INTERVAL,
  );

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setEnvironmentId(editing.environmentId ?? "");
      setLimitValue(String(editing.limitValue));
      setModels(editing.model ?? []);
      setIsAllModels(!editing.model?.length);
      setCleanupInterval(editing.cleanupInterval);
    } else {
      setEnvironmentId(initialEnvironmentId ?? "");
      setLimitValue("");
      setModels([]);
      setIsAllModels(true);
      setCleanupInterval(
        orgDefault?.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
      );
    }
  }, [open, editing, initialEnvironmentId, orgDefault?.cleanupInterval]);

  const overridden = new Map(
    defaults
      .filter((d) => d.environmentId !== null)
      .map((d) => [d.environmentId as string, d]),
  );
  const available = environments.filter((env) => !overridden.has(env.id));
  const taken = environments.filter((env) => overridden.has(env.id));
  const environmentName = (id: string | null) =>
    environments.find((env) => env.id === id)?.name ?? "this environment";

  const parsed = Number(limitValue);
  const isPending = createDefault.isPending || updateDefault.isPending;
  const canSubmit =
    !isPending &&
    (isOrganization || environmentId !== "") &&
    limitValue !== "" &&
    parsed > 0 &&
    (isAllModels || models.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    const body = {
      limitValue: parsed,
      cleanupInterval,
      model: isAllModels ? null : models,
    };
    const result = editing
      ? await updateDefault.mutateAsync({ id: editing.id, ...body })
      : await createDefault.mutateAsync({
          ...body,
          environmentId: isOrganization ? null : environmentId,
        });
    if (!result) return;
    onOpenChange(false);
    onSaved?.(result.environmentId);
  };

  const orgDefaultPhrase = orgDefault
    ? `the ${formatLimit(orgDefault.limitValue)} organization default`
    : "no default limit";
  const title = isOrganization
    ? editing
      ? "Edit organization default"
      : "Set organization default"
    : editing
      ? `Edit ${environmentName(editing.environmentId)} override`
      : "Add environment override";
  const description = isOrganization
    ? "Every user gets this spend limit, unless an environment override or a custom user limit applies to them."
    : editing
      ? `Users in ${environmentName(editing.environmentId)} get this limit instead of ${orgDefaultPhrase}.`
      : `Users in the environment you pick get this limit instead of ${orgDefaultPhrase}.`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="medium"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogBody className="space-y-4">
          {!isOrganization && !editing ? (
            <div className="space-y-2">
              <Label>Environment</Label>
              <Select value={environmentId} onValueChange={setEnvironmentId}>
                <SelectTrigger className="w-full" aria-label="Environment">
                  <SelectValue placeholder="Pick an environment" />
                </SelectTrigger>
                <SelectContent>
                  {available.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>No override yet</SelectLabel>
                      {available.map((env) => (
                        <SelectItem key={env.id} value={env.id}>
                          {env.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                  {available.length > 0 && taken.length > 0 ? (
                    <SelectSeparator />
                  ) : null}
                  {taken.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>
                        Already overridden · edit from the list
                      </SelectLabel>
                      {taken.map((env) => {
                        const override = overridden.get(env.id);
                        return (
                          <SelectItem key={env.id} value={env.id} disabled>
                            <span>{env.name}</span>
                            {override ? (
                              <span className="ml-2 text-muted-foreground tabular-nums">
                                {`${formatLimit(override.limitValue)} / ${intervalLabel(override.cleanupInterval).toLowerCase()}`}
                              </span>
                            ) : null}
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  ) : null}
                  {orgDefault ? (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Organization default</SelectLabel>
                        {/* A reminder of what the override replaces; not selectable. */}
                        <SelectItem value="__organization_default__" disabled>
                          <span>
                            {taken.length > 0
                              ? "Every other environment"
                              : "Every environment"}
                          </span>
                          <span className="ml-2 text-muted-foreground tabular-nums">
                            {`${formatLimit(orgDefault.limitValue)} / ${intervalLabel(orgDefault.cleanupInterval).toLowerCase()} · ${modelCountLabel(orgDefault.model)}`}
                          </span>
                        </SelectItem>
                      </SelectGroup>
                    </>
                  ) : null}
                </SelectContent>
              </Select>
              {available.length === 0 ? (
                <FieldDescription>
                  Every environment already has an override. Edit one from the
                  overrides list instead.
                </FieldDescription>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="default-user-limit-value">Limit per user ($)</Label>
            <Input
              id="default-user-limit-value"
              value={
                limitValue ? Number(limitValue).toLocaleString("en-US") : ""
              }
              onChange={(event) =>
                setLimitValue(event.target.value.replace(/[^0-9]/g, ""))
              }
              placeholder={
                orgDefault && !isOrganization
                  ? String(orgDefault.limitValue)
                  : "50"
              }
              inputMode="numeric"
              autoFocus={isOrganization || Boolean(editing)}
            />
          </div>

          <div className="space-y-2">
            <Label>Interval</Label>
            <LimitCleanupIntervalSelect
              value={cleanupInterval}
              onValueChange={setCleanupInterval}
            />
            <FieldDescription>
              Each user's spend resets to $0 at the start of every interval.
            </FieldDescription>
          </div>

          <div className="space-y-2">
            <Label>Models</Label>
            <LlmModelPicker
              multiple
              sortDirection="desc"
              value={isAllModels ? ["all"] : models}
              onValueChange={(values) => {
                const all = values.includes("all");
                setIsAllModels(all);
                setModels(all ? [] : values);
              }}
              models={modelOptions.map((model) => ({
                value: model.modelId,
                model: model.modelId,
                provider: model.provider,
                pricePerMillionInput: model.pricePerMillionInput ?? "0",
                pricePerMillionOutput: model.pricePerMillionOutput ?? "0",
                isFree: model.isFree,
                isBest: model.isBest,
              }))}
              editable
              includeAllOption
            />
            <FieldDescription>
              Only spend on these models counts toward the limit.
            </FieldDescription>
          </div>
        </DialogBody>

        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {editing ? "Save" : isOrganization ? "Set default" : "Add override"}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

export function DeleteDefaultLimitDialog({
  target,
  orgDefault,
  environments,
  onOpenChange,
}: {
  target: DefaultUserLimit | null;
  orgDefault: DefaultUserLimit | undefined;
  environments: Environment[];
  onOpenChange: (open: boolean) => void;
}) {
  const deleteDefault = useDeleteDefaultUserLimit();
  const environmentName = target?.environmentId
    ? (environments.find((env) => env.id === target.environmentId)?.name ??
      "this environment")
    : null;
  return (
    <DeleteConfirmDialog
      open={!!target}
      onOpenChange={onOpenChange}
      title={
        target?.environmentId
          ? `Delete the ${environmentName} override?`
          : "Delete the organization default?"
      }
      description={
        !target
          ? ""
          : target.environmentId === null
            ? "Users without an environment override or a custom limit will have no spend limit."
            : `Users in ${environmentName} will get ${orgDefault ? `the ${formatLimit(orgDefault.limitValue)} organization default` : "no limit, since there is no organization default"} instead.`
      }
      isPending={deleteDefault.isPending}
      onConfirm={async () => {
        if (!target) return;
        const result = await deleteDefault.mutateAsync({ id: target.id });
        if (result) onOpenChange(false);
      }}
    />
  );
}
