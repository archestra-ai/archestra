"use client";

import type { archestraApiTypes } from "@shared";
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
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

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
};

const DEFAULT_FORM_STATE: LimitFormState = {
  entityType: "organization",
  entityId: "",
  limitValue: "",
  model: [],
};

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
        <Plus className="h-4 w-4" />
        Add Limit
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [handleCreateOpen, setActionButton]);

  const handleEditOpen = useCallback((limit: LimitData) => {
    setEditingLimit(limit);
    setFormState({
      entityType: limit.entityType as LimitEntityType,
      entityId: limit.entityType === "organization" ? "" : limit.entityId,
      limitValue: String(limit.limitValue),
      model: getLimitModels(limit),
    });
    setModelToAdd("");
    setIsDialogOpen(true);
  }, []);

  const getEntityLabel = useCallback(
    (limit: LimitData) => {
      if (limit.entityType === "organization") return "Organization";
      const team = teams.find((candidate) => candidate.id === limit.entityId);
      return team?.name ?? "Unknown team";
    },
    [teams],
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
        (Array.isArray(limit.model) && limit.model.includes(modelFilter));

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
                {model}
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
    const body = {
      entityType: formState.entityType,
      entityId:
        formState.entityType === "organization"
          ? (organization?.id ?? "")
          : formState.entityId,
      limitType: "token_cost" as const,
      limitValue: Number(formState.limitValue),
      model: formState.model,
    };

    if (editingLimit) {
      const result = await updateLimit.mutateAsync({
        id: editingLimit.id,
        ...body,
      });
      if (result) {
        setIsDialogOpen(false);
        setEditingLimit(null);
      }
      return;
    }

    const result = await createLimit.mutateAsync(body);
    if (result) {
      setIsDialogOpen(false);
    }
  }

  async function handleDelete() {
    if (!limitToDelete) return;
    await deleteLimit.mutateAsync({ id: limitToDelete.id });
    setLimitToDelete(null);
  }

  const canSubmit =
    Number(formState.limitValue) > 0 &&
    formState.model.length > 0 &&
    (formState.entityType === "organization" || formState.entityId.length > 0);

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
        description="Configure scoped LLM token-cost limits for the organization or a team."
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
              </div>
            </div>

            <div className="space-y-2">
              <Label>Add model</Label>
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
              <Label>Limit value ($)</Label>
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
              />
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
