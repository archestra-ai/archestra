"use client";

import {
  ALL_MODELS_SENTINEL,
  type archestraApiTypes,
  validateLimitShape,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleHelp, Edit, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSetCostsAction } from "@/app/llm/(costs)/layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useCreateLimit,
  useDeleteLimit,
  useLimits,
  useUpdateLimit,
} from "@/lib/limits.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import {
  useOrganization,
  useOrganizationMembers,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

type LimitData = archestraApiTypes.GetLimitsResponses["200"][number];
type LimitEntityType = archestraApiTypes.CreateLimitData["body"]["entityType"];
type UsageStatus = "safe" | "warning" | "danger";
type LimitCleanupInterval = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateLlmSettingsData["body"]
  >["limitCleanupInterval"]
>;

type LimitFormState = {
  entityType: LimitEntityType;
  entityId: string;
  limitValue: string;
  model: string[];
  wideLimitValue: string;
};

const DEFAULT_FORM_STATE: LimitFormState = {
  entityType: "organization",
  entityId: "",
  limitValue: "",
  model: [],
  wideLimitValue: "",
};

const ENTITY_TYPE_NOUN: Record<LimitEntityType, string> = {
  organization: "organization",
  team: "team",
  agent: "agent",
  user: "user",
  virtual_api_key: "virtual API key",
};

function isWideLimit(limit: LimitData) {
  const models = getLimitModels(limit);
  return models.length === 1 && models[0] === ALL_MODELS_SENTINEL;
}

const CLEANUP_INTERVAL_LABELS: Record<LimitCleanupInterval, string> = {
  "1h": "Every hour",
  "12h": "Every 12 hours",
  "24h": "Every 24 hours",
  "1w": "Every week",
  "1m": "Every month",
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

export default function LimitsPage() {
  const setActionButton = useSetCostsAction();
  const { data: limits = [], isPending } = useLimits();
  const { data: teams = [] } = useTeams();
  const { data: allVirtualApiKeysData } = useAllVirtualApiKeys({ limit: 100 });
  const orgVirtualApiKeys = allVirtualApiKeysData?.data ?? [];
  const { data: organization } = useOrganization();
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const deleteLimit = useDeleteLimit();

  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const statusFilter = searchParams.get("status") || "all";
  const appliedToFilter = searchParams.get("appliedTo") || "all";
  const modelFilter = searchParams.get("model") || "all";
  const [modelToAdd, setModelToAdd] = useState("");
  const [editingLimit, setEditingLimit] = useState<LimitData | null>(null);
  const [limitToDelete, setLimitToDelete] = useState<LimitData | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formState, setFormState] =
    useState<LimitFormState>(DEFAULT_FORM_STATE);
  const { data: members = [] } = useOrganizationMembers(isDialogOpen);

  const llmLimits = useMemo(
    () => limits.filter((limit) => limit.limitType === "token_cost"),
    [limits],
  );

  const modelOptions = useMemo(
    () =>
      modelsWithApiKeys.map((model) => ({
        value: model.modelId,
        model: model.modelId,
        provider: model.provider,
        pricePerMillionInput: model.pricePerMillionInput ?? "0",
        pricePerMillionOutput: model.pricePerMillionOutput ?? "0",
      })),
    [modelsWithApiKeys],
  );

  const resolvedEntityId =
    formState.entityType === "organization"
      ? (organization?.id ?? "")
      : formState.entityId;

  const existingWideLimit = useMemo(() => {
    if (!resolvedEntityId) return null;
    return (
      llmLimits.find(
        (candidate) =>
          candidate.entityType === formState.entityType &&
          candidate.entityId === resolvedEntityId &&
          isWideLimit(candidate) &&
          (!editingLimit || candidate.id !== editingLimit.id),
      ) ?? null
    );
  }, [llmLimits, formState.entityType, resolvedEntityId, editingLimit]);

  useEffect(() => {
    if (!isDialogOpen) return;
    if (editingLimit && isWideLimit(editingLimit)) return;
    setFormState((current) => ({
      ...current,
      wideLimitValue: existingWideLimit
        ? String(existingWideLimit.limitValue)
        : "",
    }));
  }, [existingWideLimit, isDialogOpen, editingLimit]);

  const handleCreateOpen = useCallback(() => {
    setEditingLimit(null);
    setFormState(DEFAULT_FORM_STATE);
    setModelToAdd("");
    setIsDialogOpen(true);
  }, []);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ llmLimit: ["create"] }}
        onClick={handleCreateOpen}
      >
        <Plus className="mr-2 h-4 w-4" />
        Add Limit
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [handleCreateOpen, setActionButton]);

  const handleEditOpen = useCallback((limit: LimitData) => {
    setEditingLimit(limit);
    const wide = isWideLimit(limit);
    setFormState({
      entityType: limit.entityType as LimitEntityType,
      entityId: limit.entityType === "organization" ? "" : limit.entityId,
      limitValue: wide ? "" : String(limit.limitValue),
      model: wide ? [] : getLimitModels(limit),
      wideLimitValue: wide ? String(limit.limitValue) : "",
    });
    setModelToAdd("");
    setIsDialogOpen(true);
  }, []);

  const getEntityLabel = useCallback(
    (limit: LimitData) => {
      if (limit.entityType === "organization") return "Organization";
      if (limit.entityType === "team") {
        const team = teams.find((candidate) => candidate.id === limit.entityId);
        return team?.name ?? "Unknown team";
      }
      if (limit.entityType === "user") {
        const member = members.find((m) => m.id === limit.entityId);
        return member?.name || member?.email || "Unknown user";
      }
      if (limit.entityType === "virtual_api_key") {
        const vkey = orgVirtualApiKeys.find((k) => k.id === limit.entityId);
        return vkey?.name ?? "Unknown virtual key";
      }
      // Historical `agent` rows (created via API/MCP before the UI picker
      // covered them) render as raw ID rather than breaking the table.
      return limit.entityId;
    },
    [teams, members, orgVirtualApiKeys],
  );

  const getUsageStatus = useCallback(
    (
      limit: LimitData,
    ): {
      percentage: number;
      status: UsageStatus;
      actualUsage: number;
      actualLimit: number;
    } => {
      const actualUsage = (limit.modelUsage ?? []).reduce(
        (sum, usage) => sum + usage.cost,
        0,
      );
      const actualLimit = limit.limitValue;
      const percentage =
        actualLimit > 0 ? (actualUsage / actualLimit) * 100 : 0;
      if (percentage >= 90) {
        return { percentage, status: "danger", actualUsage, actualLimit };
      }
      if (percentage >= 75) {
        return { percentage, status: "warning", actualUsage, actualLimit };
      }
      return { percentage, status: "safe", actualUsage, actualLimit };
    },
    [],
  );

  const filteredLimits = useMemo(() => {
    return llmLimits.filter((limit) => {
      const usageStatus = getUsageStatus(limit).status;
      const matchesStatus =
        statusFilter === "all" || usageStatus === statusFilter;
      const matchesAppliedTo =
        appliedToFilter === "all" || limit.entityType === appliedToFilter;
      const matchesModel =
        modelFilter === "all" ||
        (Array.isArray(limit.model) &&
          (limit.model.includes(modelFilter) ||
            limit.model.includes(ALL_MODELS_SENTINEL)));

      return matchesStatus && matchesAppliedTo && matchesModel;
    });
  }, [appliedToFilter, llmLimits, modelFilter, statusFilter, getUsageStatus]);

  const columns = useMemo<ColumnDef<LimitData>[]>(
    () => [
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const status = getUsageStatus(row.original).status;
          return (
            <Badge
              variant={
                status === "danger"
                  ? "destructive"
                  : status === "warning"
                    ? "secondary"
                    : "outline"
              }
            >
              {status === "danger"
                ? "Exceeded"
                : status === "warning"
                  ? "Near limit"
                  : "Safe"}
            </Badge>
          );
        },
      },
      {
        accessorKey: "entityId",
        header: "Applied to",
        cell: ({ row }) => getEntityLabel(row.original),
      },
      {
        accessorKey: "model",
        header: "Models",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {getLimitModels(row.original).map((model) => (
              <Badge key={model} variant="outline" className="text-xs">
                {model === ALL_MODELS_SENTINEL ? "All models" : model}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        accessorKey: "usage",
        header: "Usage",
        cell: ({ row }) => {
          const usage = getUsageStatus(row.original);
          return (
            <div className="w-[180px]">
              <Progress
                value={Math.min(usage.percentage, 100)}
                className={
                  usage.status === "danger"
                    ? "bg-red-100"
                    : usage.status === "warning"
                      ? "bg-orange-100"
                      : undefined
                }
              />
              <p className="mt-1 text-left text-xs text-muted-foreground">
                {`${formatCurrencyWhole(usage.actualUsage)} / ${formatCurrencyWhole(usage.actualLimit)} (${usage.percentage.toFixed(1)}%)`}
              </p>
            </div>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              {
                icon: <Edit className="h-4 w-4" />,
                label: "Edit limit",
                onClick: () => handleEditOpen(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete limit",
                variant: "destructive",
                onClick: () => setLimitToDelete(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [getEntityLabel, getUsageStatus, handleEditOpen],
  );

  const hasActiveFilters =
    statusFilter !== "all" ||
    appliedToFilter !== "all" ||
    modelFilter !== "all";
  const cleanupIntervalLabel =
    CLEANUP_INTERVAL_LABELS[
      (organization?.limitCleanupInterval as LimitCleanupInterval) ?? "1h"
    ];

  async function handleSubmit() {
    const entityId = resolvedEntityId;
    if (!entityId) return;

    const specificValue = Number(formState.limitValue) || 0;
    const wideValue = Number(formState.wideLimitValue) || 0;
    const hasSpecific = formState.model.length > 0 && specificValue > 0;
    const hasWide = wideValue > 0;

    const specificBody = hasSpecific
      ? {
          entityType: formState.entityType,
          entityId,
          limitType: "token_cost" as const,
          limitValue: specificValue,
          model: formState.model,
        }
      : null;
    const wideBody = hasWide
      ? {
          entityType: formState.entityType,
          entityId,
          limitType: "token_cost" as const,
          limitValue: wideValue,
          model: [ALL_MODELS_SENTINEL],
        }
      : null;

    if (specificBody && !validateLimitShape(specificBody)) return;
    if (wideBody && !validateLimitShape(wideBody)) return;

    if (editingLimit && isWideLimit(editingLimit)) {
      if (wideBody) {
        await updateLimit.mutateAsync({ id: editingLimit.id, ...wideBody });
      }
      if (specificBody) {
        await createLimit.mutateAsync(specificBody);
      }
    } else if (editingLimit) {
      if (specificBody) {
        await updateLimit.mutateAsync({ id: editingLimit.id, ...specificBody });
      }
      if (wideBody && wideValue !== (existingWideLimit?.limitValue ?? 0)) {
        if (existingWideLimit) {
          await updateLimit.mutateAsync({
            id: existingWideLimit.id,
            ...wideBody,
          });
        } else {
          await createLimit.mutateAsync(wideBody);
        }
      }
    } else {
      if (specificBody) {
        await createLimit.mutateAsync(specificBody);
      }
      if (wideBody && wideValue !== (existingWideLimit?.limitValue ?? 0)) {
        if (existingWideLimit) {
          await updateLimit.mutateAsync({
            id: existingWideLimit.id,
            ...wideBody,
          });
        } else {
          await createLimit.mutateAsync(wideBody);
        }
      }
    }

    setIsDialogOpen(false);
    setEditingLimit(null);
  }

  async function handleDelete() {
    if (!limitToDelete) return;
    await deleteLimit.mutateAsync({ id: limitToDelete.id });
    setLimitToDelete(null);
  }

  const entitySelected =
    formState.entityType === "organization" || formState.entityId.length > 0;
  const hasValidSpecific =
    formState.model.length > 0 && Number(formState.limitValue) > 0;
  const hasValidWide = Number(formState.wideLimitValue) > 0;
  const canSubmit = entitySelected && (hasValidSpecific || hasValidWide);

  return (
    <div className="space-y-4">
      <Alert variant="info">
        <CircleHelp />
        <AlertDescription className="sm:flex sm:flex-wrap sm:items-center sm:gap-1">
          <span>
            Expired or exceeded limits reset on the current cleanup schedule:
          </span>
          <span className="font-medium text-foreground">
            {cleanupIntervalLabel}
          </span>
          <Link
            href="/settings/llm"
            className="font-medium underline underline-offset-4"
          >
            Change it in LLM settings
          </Link>
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap gap-3">
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            updateQueryParams({ status: value === "all" ? null : value })
          }
        >
          <SelectTrigger className="w-full sm:w-[220px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="safe">Safe</SelectItem>
            <SelectItem value="warning">Near limit</SelectItem>
            <SelectItem value="danger">Exceeded</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={appliedToFilter}
          onValueChange={(value) =>
            updateQueryParams({ appliedTo: value === "all" ? null : value })
          }
        >
          <SelectTrigger className="w-full sm:w-[220px]">
            <SelectValue placeholder="All scopes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All applied to</SelectItem>
            <SelectItem value="organization">Organization</SelectItem>
            <SelectItem value="team">Team</SelectItem>
            <SelectItem value="user">User</SelectItem>
            <SelectItem value="virtual_api_key">Virtual API Key</SelectItem>
          </SelectContent>
        </Select>

        <LlmModelSearchableSelect
          value={modelFilter}
          onValueChange={(value) =>
            updateQueryParams({ model: value === "all" ? null : value })
          }
          options={modelOptions}
          placeholder="All models"
          className="sm:max-w-[320px]"
          showPricing={false}
          includeAllOption
          allLabel="All models"
        />
      </div>

      <LoadingWrapper
        isPending={isPending}
        loadingFallback={<LoadingSpinner />}
      >
        <DataTable
          columns={columns}
          data={filteredLimits}
          emptyMessage="No limits configured"
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No limits match your filters. Try adjusting your search."
          onClearFilters={() => {
            updateQueryParams({ status: null, appliedTo: null, model: null });
          }}
        />
      </LoadingWrapper>

      <FormDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={editingLimit ? "Edit limit" : "Create limit"}
        description="Configure scoped LLM token-cost limits for the organization, a team, a user, or a virtual API key."
        size="small"
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
              <Label>Apply to</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  value={formState.entityType}
                  onValueChange={(value: LimitEntityType) =>
                    setFormState((current) => ({
                      ...current,
                      entityType: value,
                      entityId: "",
                    }))
                  }
                >
                  <SelectTrigger className="w-full sm:flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="organization">Organization</SelectItem>
                    <SelectItem value="team">Team</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="virtual_api_key">
                      Virtual API Key
                    </SelectItem>
                  </SelectContent>
                </Select>

                {formState.entityType === "team" && (
                  <Select
                    value={formState.entityId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityId: value,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full sm:flex-1">
                      <SelectValue placeholder="Select team" />
                    </SelectTrigger>
                    <SelectContent>
                      {teams.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {formState.entityType === "user" && (
                  <Select
                    value={formState.entityId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityId: value,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full sm:flex-1">
                      <SelectValue placeholder="Select user" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((member) => (
                        <SelectItem key={member.id} value={member.id}>
                          {member.name || member.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {formState.entityType === "virtual_api_key" && (
                  <Select
                    value={formState.entityId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityId: value,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full sm:flex-1">
                      <SelectValue placeholder="Select virtual API key" />
                    </SelectTrigger>
                    <SelectContent>
                      {orgVirtualApiKeys.map((vkey) => (
                        <SelectItem key={vkey.id} value={vkey.id}>
                          {vkey.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {formState.entityType === "user" && (
                <p className="text-xs text-muted-foreground">
                  Personal budgets cap a user's spend across Chat UI, internal
                  automation, and JWKS-authenticated calls. Virtual API key
                  traffic is not counted — use virtual-key-scope budgets for
                  those.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Models</Label>
              <LlmModelSearchableSelect
                value={modelToAdd}
                onValueChange={(value) => {
                  setModelToAdd("");
                  setFormState((current) => ({
                    ...current,
                    model: current.model.includes(value)
                      ? current.model
                      : [...current.model, value],
                  }));
                }}
                options={modelOptions}
                placeholder="Select model..."
                showPricing
              />
              <div className="flex flex-wrap gap-1">
                {formState.model.map((model) => (
                  <Badge key={model} variant="secondary" className="gap-1 pr-1">
                    {model}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4"
                      onClick={() =>
                        setFormState((current) => ({
                          ...current,
                          model: current.model.filter(
                            (currentModel) => currentModel !== model,
                          ),
                        }))
                      }
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Limit value for selected models ($)</Label>
              <Input
                value={formatNumericInput(formState.limitValue)}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    limitValue: event.target.value.replace(/[^0-9]/g, ""),
                  }))
                }
                placeholder="1,000"
                inputMode="numeric"
                disabled={formState.model.length === 0}
              />
              <p className="text-xs text-muted-foreground">
                Applies only to the models picked above. Leave empty to skip
                per-model limits.
              </p>
            </div>

            <div className="space-y-2 rounded-md border border-dashed p-3">
              <Label>
                Overall limit for this {ENTITY_TYPE_NOUN[formState.entityType]}{" "}
                ($)
              </Label>
              <Input
                value={formatNumericInput(formState.wideLimitValue)}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    wideLimitValue: event.target.value.replace(/[^0-9]/g, ""),
                  }))
                }
                placeholder="Not set"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">
                Caps total spend for this{" "}
                {ENTITY_TYPE_NOUN[formState.entityType]} across every model,
                including new models as they are added. Independent from the
                per-model limit above.
                {existingWideLimit
                  ? " To remove this cap, delete it from the limits list."
                  : ""}
              </p>
            </div>
          </DialogBody>
          <DialogStickyFooter className="mt-0">
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
              {editingLimit ? "Save changes" : "Create limit"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!limitToDelete}
        onOpenChange={(open) => !open && setLimitToDelete(null)}
        title="Delete limit"
        description="This action cannot be undone."
        isPending={deleteLimit.isPending}
        onConfirm={handleDelete}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
    </div>
  );
}

function getLimitModels(limit: LimitData): string[] {
  return Array.isArray(limit.model)
    ? limit.model.filter((model): model is string => typeof model === "string")
    : [];
}
