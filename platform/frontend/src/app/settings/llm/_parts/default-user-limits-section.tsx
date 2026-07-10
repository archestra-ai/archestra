"use client";

import { Boxes, Edit, Globe, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  EnvironmentScopeSelect,
  GLOBAL_ENVIRONMENT_SCOPE,
  GLOBAL_ENVIRONMENT_SCOPE_LABEL,
} from "@/components/environment-scope-select";
import { FormDialog } from "@/components/form-dialog";
import {
  CLEANUP_INTERVAL_LABELS,
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  type LimitCleanupInterval,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type DefaultUserLimit,
  useCreateDefaultUserLimit,
  useDefaultUserLimits,
  useDeleteDefaultUserLimit,
  useUpdateDefaultUserLimit,
} from "@/lib/default-user-limit.query";
import { useEnvironments } from "@/lib/environment.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";

type FormState = {
  // GLOBAL_ENVIRONMENT_SCOPE for the org-wide default, otherwise an environment id.
  scope: string;
  limitValue: string;
  models: string[];
  isAllModels: boolean;
  cleanupInterval: LimitCleanupInterval;
};

const EMPTY_FORM_STATE: FormState = {
  scope: "",
  limitValue: "",
  models: [],
  isAllModels: true,
  cleanupInterval: DEFAULT_LIMIT_CLEANUP_INTERVAL,
};

function formatCurrencyWhole(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumericInput(value: string) {
  if (!value) return "";
  return Number(value).toLocaleString("en-US");
}

export function DefaultUserLimitsSection() {
  const { data: environmentsData } = useEnvironments();
  const environments = environmentsData?.environments ?? [];
  const { data: limits = [] } = useDefaultUserLimits();
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const createLimit = useCreateDefaultUserLimit();
  const updateLimit = useUpdateDefaultUserLimit();
  const deleteLimit = useDeleteDefaultUserLimit();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DefaultUserLimit | null>(null);
  const [formState, setFormState] = useState<FormState>(EMPTY_FORM_STATE);
  const [toDelete, setToDelete] = useState<DefaultUserLimit | null>(null);

  const modelOptions = modelsWithApiKeys.map((model) => ({
    value: model.modelId,
    model: model.modelId,
    provider: model.provider,
    pricePerMillionInput: model.pricePerMillionInput ?? "0",
    pricePerMillionOutput: model.pricePerMillionOutput ?? "0",
    isFree: model.isFree,
    isBest: model.isBest,
  }));

  const hasGlobal = limits.some((limit) => limit.environmentId === null);

  const scopeLabel = (environmentId: string | null) => {
    if (environmentId === null) return GLOBAL_ENVIRONMENT_SCOPE_LABEL;
    return (
      environments.find((environment) => environment.id === environmentId)
        ?.name ?? "Unknown environment"
    );
  };

  // Scopes that already have a limit. They stay visible in the dropdown but are
  // disabled, since there's at most one default per environment (and one global).
  const takenScopes = new Set<string>(
    limits.map((limit) =>
      limit.environmentId === null
        ? GLOBAL_ENVIRONMENT_SCOPE
        : limit.environmentId,
    ),
  );

  const handleAddOpen = () => {
    setEditing(null);
    setFormState({
      ...EMPTY_FORM_STATE,
      // Pre-select the org-wide default when it isn't configured yet, so the
      // environment field can be left untouched for the common case.
      scope: hasGlobal ? "" : GLOBAL_ENVIRONMENT_SCOPE,
    });
    setIsDialogOpen(true);
  };

  const handleEditOpen = (limit: DefaultUserLimit) => {
    setEditing(limit);
    const models = Array.isArray(limit.model) ? limit.model : [];
    setFormState({
      scope:
        limit.environmentId === null
          ? GLOBAL_ENVIRONMENT_SCOPE
          : limit.environmentId,
      limitValue: String(limit.limitValue),
      models,
      isAllModels: models.length === 0,
      cleanupInterval: limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
    });
    setIsDialogOpen(true);
  };

  const canSubmit =
    Number(formState.limitValue) > 0 &&
    (formState.isAllModels || formState.models.length > 0) &&
    formState.scope.length > 0;

  async function handleSubmit() {
    const model = formState.isAllModels ? null : formState.models;
    const limitValue = Number(formState.limitValue);

    if (editing) {
      const result = await updateLimit.mutateAsync({
        id: editing.id,
        limitValue,
        model,
        cleanupInterval: formState.cleanupInterval,
      });
      if (result) {
        setIsDialogOpen(false);
        setEditing(null);
      }
      return;
    }

    const result = await createLimit.mutateAsync({
      environmentId:
        formState.scope === GLOBAL_ENVIRONMENT_SCOPE ? null : formState.scope,
      limitValue,
      model,
      cleanupInterval: formState.cleanupInterval,
    });
    if (result) {
      setIsDialogOpen(false);
    }
  }

  async function handleDelete() {
    if (!toDelete) return;
    await deleteLimit.mutateAsync({ id: toDelete.id });
    setToDelete(null);
  }

  // Nothing left to add once the global default and every environment have a row.
  const nothingToAdd =
    hasGlobal && environments.every((env) => takenScopes.has(env.id));

  return (
    <SettingsBlock
      title="Default user limits"
      description="Set a token-cost limit applied to every member. The 'All environments' default applies everywhere; add a per-environment row to override it for that environment (e.g. a smaller cap in production). A custom per-user limit overrides these defaults."
      control={
        <PermissionButton
          permissions={{ llmLimit: ["create"] }}
          onClick={handleAddOpen}
          disabled={nothingToAdd && !editing}
        >
          <Plus className="h-4 w-4" />
          Add limit
        </PermissionButton>
      }
    >
      {limits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No default user limits configured.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Models</TableHead>
              <TableHead>Limit value</TableHead>
              <TableHead>Cleanup interval</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {limits.map((limit) => {
              const models = Array.isArray(limit.model) ? limit.model : [];
              const isGlobal = limit.environmentId === null;
              return (
                <TableRow key={limit.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      {isGlobal ? (
                        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      {scopeLabel(limit.environmentId)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {models.length === 0 ? "All models" : models.join(", ")}
                  </TableCell>
                  <TableCell>{formatCurrencyWhole(limit.limitValue)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {CLEANUP_INTERVAL_LABELS[
                      limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL
                    ] ?? limit.cleanupInterval}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <WithPermissions
                        permissions={{ llmLimit: ["update"] }}
                        noPermissionHandle="hide"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditOpen(limit)}
                          aria-label="Edit limit"
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </WithPermissions>
                      <WithPermissions
                        permissions={{ llmLimit: ["delete"] }}
                        noPermissionHandle="hide"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setToDelete(limit)}
                          aria-label="Delete limit"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </WithPermissions>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <FormDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={editing ? "Edit default user limit" : "Add default user limit"}
        description="Set a per-user token-cost cap, optionally scoped to an environment."
        size="medium"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label>Models</Label>
              <LlmModelPicker
                multiple
                sortDirection="desc"
                value={formState.isAllModels ? ["all"] : formState.models}
                onValueChange={(values) => {
                  const isAllModels = values.includes("all");
                  setFormState((current) => ({
                    ...current,
                    isAllModels,
                    models: isAllModels ? [] : values,
                  }));
                }}
                models={modelOptions}
                editable
                includeAllOption
              />
            </div>

            <div className="space-y-2">
              <Label>Limit value ($)</Label>
              <Input
                aria-label="Limit value"
                value={formatNumericInput(formState.limitValue)}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    limitValue: event.target.value.replace(/[^0-9]/g, ""),
                  }))
                }
                placeholder="1,000"
                inputMode="numeric"
              />
            </div>

            <div className="space-y-2">
              <Label>Cleanup interval</Label>
              <LimitCleanupIntervalSelect
                value={formState.cleanupInterval}
                onValueChange={(value) =>
                  setFormState((current) => ({
                    ...current,
                    cleanupInterval: value,
                  }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label>Environment (optional)</Label>
              {editing ? (
                <Input value={scopeLabel(editing.environmentId)} disabled />
              ) : (
                <EnvironmentScopeSelect
                  value={formState.scope}
                  onValueChange={(value) =>
                    setFormState((current) => ({ ...current, scope: value }))
                  }
                  environments={environments}
                  includeGlobalOption
                  takenValues={takenScopes}
                />
              )}
              <p className="text-xs text-muted-foreground">
                Leave as “{GLOBAL_ENVIRONMENT_SCOPE_LABEL}” to set the
                organization-wide default, or pick an environment to override it
                there.
              </p>
            </div>
          </DialogBody>

          <DialogStickyFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !canSubmit || createLimit.isPending || updateLimit.isPending
              }
            >
              {editing ? "Save" : "Add"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!toDelete}
        onOpenChange={(open) => !open && setToDelete(null)}
        title="Delete default user limit"
        description={
          toDelete
            ? toDelete.environmentId === null
              ? "Remove the organization-wide default user limit? Members will have no default cap except where a per-environment limit applies."
              : `Remove the per-user limit for ${scopeLabel(toDelete.environmentId)}? Usage in this environment will fall back to the organization-wide default.`
            : ""
        }
        isPending={deleteLimit.isPending}
        onConfirm={handleDelete}
      />
    </SettingsBlock>
  );
}
