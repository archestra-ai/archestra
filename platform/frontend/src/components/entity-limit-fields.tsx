"use client";

import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LimitCleanupInterval } from "@/components/limit-cleanup-interval-select";
import {
  CLEANUP_INTERVAL_LABELS,
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCreateLimit,
  useDeleteLimit,
  useLimits,
  useUpdateLimit,
} from "@/lib/limits.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";

export type { LimitCleanupInterval };

export type LimitEntityType =
  | "organization"
  | "team"
  | "agent"
  | "user"
  | "virtual_key";

export interface PendingLimit {
  tempId: string;
  limitValue: string;
  cleanupInterval: LimitCleanupInterval;
  models: string[];
  isAllModels: boolean;
}

export const DEFAULT_PENDING_LIMIT: PendingLimit = {
  tempId: "",
  limitValue: "",
  cleanupInterval: DEFAULT_LIMIT_CLEANUP_INTERVAL,
  models: [],
  isAllModels: true,
};

function formatNumericInput(value: string) {
  if (!value) return "";
  return Number(value).toLocaleString("en-US");
}

function formatModelSummary(limit: PendingLimit): string {
  if (limit.isAllModels) return "All models";
  if (limit.models.length === 0) return "All models";
  if (limit.models.length === 1) return limit.models[0];
  return `${limit.models.length} models`;
}

export interface EntityLimitManagerProps {
  entityType: LimitEntityType;
  entityId?: string | null;
  disabled?: boolean;
}

export function EntityLimitManager({
  entityType,
  entityId,
  disabled,
}: EntityLimitManagerProps) {
  const isEditMode = !!entityId;

  const { data: apiLimits = [] } = useLimits(
    isEditMode ? { entityType, entityId } : undefined,
  );

  const existingLimits = useMemo(
    () => apiLimits.filter((l) => l.limitType === "token_cost"),
    [apiLimits],
  );

  const [pendingLimits, setPendingLimits] = useState<PendingLimit[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingIsExisting, setEditingIsExisting] = useState(false);
  const [draftLimit, setDraftLimit] = useState<PendingLimit>(
    DEFAULT_PENDING_LIMIT,
  );

  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const deleteLimit = useDeleteLimit();

  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();

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

  const limitToPending = useCallback(
    (limit: (typeof existingLimits)[number]): PendingLimit => {
      const models = Array.isArray(limit.model)
        ? limit.model.filter((m): m is string => typeof m === "string")
        : [];
      const isAllModels =
        models.length === 0 && limit.limitType === "token_cost";
      return {
        tempId: crypto.randomUUID(),
        limitValue: String(limit.limitValue),
        cleanupInterval:
          (limit.cleanupInterval as LimitCleanupInterval) ??
          DEFAULT_LIMIT_CLEANUP_INTERVAL,
        models: isAllModels ? [] : models,
        isAllModels,
      };
    },
    [],
  );

  const handleStartEditExisting = useCallback(
    (index: number) => {
      const limit = existingLimits[index];
      if (!limit) return;
      setDraftLimit(limitToPending(limit));
      setEditingIndex(index);
      setEditingIsExisting(true);
    },
    [existingLimits, limitToPending],
  );

  const handleStartEditPending = useCallback(
    (index: number) => {
      setDraftLimit((prev) => {
        const limit = pendingLimits[index];
        return limit ? { ...limit } : prev;
      });
      setEditingIndex(index);
      setEditingIsExisting(false);
    },
    [pendingLimits],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingIndex(null);
    setEditingIsExisting(false);
    setDraftLimit(DEFAULT_PENDING_LIMIT);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!draftLimit.limitValue) return;

    if (editingIsExisting && isEditMode) {
      const limit = existingLimits[editingIndex ?? -1];
      if (!limit) return;
      await updateLimit.mutateAsync({
        id: limit.id,
        entityType,
        entityId: limit.entityId,
        limitType: "token_cost",
        limitValue: Number(draftLimit.limitValue),
        cleanupInterval: draftLimit.cleanupInterval,
        model: draftLimit.isAllModels ? null : draftLimit.models,
      });
    } else {
      setPendingLimits((prev) => {
        const next = [...prev];
        if (editingIndex !== null && editingIndex >= 0) {
          next[editingIndex] = { ...draftLimit };
        }
        return next;
      });
    }

    setEditingIndex(null);
    setEditingIsExisting(false);
    setDraftLimit(DEFAULT_PENDING_LIMIT);
  }, [
    draftLimit,
    editingIndex,
    editingIsExisting,
    entityType,
    existingLimits,
    isEditMode,
    updateLimit,
  ]);

  const handleAddNew = useCallback(async () => {
    if (!draftLimit.limitValue) return;

    if (isEditMode) {
      if (!entityId) return;
      await createLimit.mutateAsync({
        entityType,
        entityId,
        limitType: "token_cost",
        limitValue: Number(draftLimit.limitValue),
        cleanupInterval: draftLimit.cleanupInterval,
        model: draftLimit.isAllModels ? null : draftLimit.models,
      });
    } else {
      setPendingLimits((prev) => [
        ...prev,
        { ...draftLimit, tempId: crypto.randomUUID() },
      ]);
    }

    setDraftLimit(DEFAULT_PENDING_LIMIT);
  }, [draftLimit, entityType, entityId, isEditMode, createLimit]);

  const handleDeleteExisting = useCallback(
    async (index: number) => {
      const limit = existingLimits[index];
      if (!limit) return;
      await deleteLimit.mutateAsync({ id: limit.id });
    },
    [existingLimits, deleteLimit],
  );

  const handleDeletePending = useCallback((index: number) => {
    setPendingLimits((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const limitForm = (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>Limit value ($)</Label>
        <Input
          value={formatNumericInput(draftLimit.limitValue)}
          onChange={(event) =>
            setDraftLimit({
              ...draftLimit,
              limitValue: event.target.value.replace(/[^0-9]/g, ""),
            })
          }
          placeholder="1,000"
          inputMode="numeric"
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label>Cleanup interval</Label>
        <LimitCleanupIntervalSelect
          value={draftLimit.cleanupInterval}
          onValueChange={(value) =>
            setDraftLimit({ ...draftLimit, cleanupInterval: value })
          }
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label>Select models</Label>
        <LlmModelPicker
          multiple
          sortDirection="desc"
          value={draftLimit.isAllModels ? ["all"] : draftLimit.models}
          onValueChange={(values) => {
            const isAllModels = values.includes("all");
            setDraftLimit({
              ...draftLimit,
              models: isAllModels ? [] : values,
              isAllModels,
            });
          }}
          models={modelOptions}
          editable
          includeAllOption
        />
      </div>
    </div>
  );

  const totalCount = existingLimits.length + pendingLimits.length;

  return (
    <div className="space-y-4">
      {totalCount > 0 && (
        <div className="space-y-2">
          <Label>Configured Limits</Label>
          <div className="space-y-2">
            {existingLimits.map((limit, index) => {
              const pending = limitToPending(limit);

              return (
                <div
                  key={limit.id}
                  className="rounded-md border bg-muted/20 px-3 py-2"
                >
                  {editingIndex === index && editingIsExisting ? (
                    <div className="space-y-3">
                      {limitForm}
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleCancelEdit}
                        >
                          <X className="mr-1 h-3 w-3" />
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleSaveEdit}
                          disabled={!draftLimit.limitValue}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-sm font-medium">
                          ${formatNumericInput(pending.limitValue)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {CLEANUP_INTERVAL_LABELS[pending.cleanupInterval]} ·{" "}
                          {formatModelSummary(pending)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => handleStartEditExisting(index)}
                          aria-label="Edit limit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteExisting(index)}
                          aria-label="Delete limit"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {pendingLimits.map((pending, index) => {
              const absoluteIndex = existingLimits.length + index;

              return (
                <div
                  key={pending.tempId}
                  className="rounded-md border bg-muted/20 px-3 py-2"
                >
                  {editingIndex === absoluteIndex && !editingIsExisting ? (
                    <div className="space-y-3">
                      {limitForm}
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleCancelEdit}
                        >
                          <X className="mr-1 h-3 w-3" />
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleSaveEdit}
                          disabled={!draftLimit.limitValue}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-sm font-medium">
                          ${formatNumericInput(pending.limitValue)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {CLEANUP_INTERVAL_LABELS[pending.cleanupInterval]} ·{" "}
                          {formatModelSummary(pending)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => handleStartEditPending(index)}
                          aria-label="Edit limit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeletePending(index)}
                          aria-label="Delete limit"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {editingIndex === null && (
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">
              {totalCount > 0 ? "Add New Limit" : "New Limit"}
            </Label>
          </div>
          {limitForm}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddNew}
              disabled={!draftLimit.limitValue || disabled}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Legacy exports for backward compatibility during migration
export type EntityLimitFormState = {
  enabled: boolean;
  limitValue: string;
  cleanupInterval: LimitCleanupInterval;
  models: string[];
  isAllModels: boolean;
};

export const DEFAULT_ENTITY_LIMIT_STATE: EntityLimitFormState = {
  enabled: false,
  limitValue: "",
  cleanupInterval: DEFAULT_LIMIT_CLEANUP_INTERVAL,
  models: [],
  isAllModels: true,
};

export interface EntityLimitFieldsProps {
  state: EntityLimitFormState;
  onChange: (state: EntityLimitFormState) => void;
  disabled?: boolean;
}

export function EntityLimitFields({
  state,
  onChange,
  disabled,
}: EntityLimitFieldsProps) {
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();

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

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Limit value ($)</Label>
        <Input
          value={formatNumericInput(state.limitValue)}
          onChange={(event) =>
            onChange({
              ...state,
              limitValue: event.target.value.replace(/[^0-9]/g, ""),
            })
          }
          placeholder="1,000"
          inputMode="numeric"
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label>Cleanup interval</Label>
        <LimitCleanupIntervalSelect
          value={state.cleanupInterval}
          onValueChange={(value) =>
            onChange({ ...state, cleanupInterval: value })
          }
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label>Select models</Label>
        <LlmModelPicker
          multiple
          sortDirection="desc"
          value={state.isAllModels ? ["all"] : state.models}
          onValueChange={(values) => {
            const isAllModels = values.includes("all");
            onChange({
              ...state,
              models: isAllModels ? [] : values,
              isAllModels,
            });
          }}
          models={modelOptions}
          editable
          includeAllOption
        />
      </div>
    </div>
  );
}

export interface UseEntityLimitParams {
  entityType: LimitEntityType;
  entityId?: string | null;
  enabled?: boolean;
}

export function useEntityLimit({
  entityType,
  entityId,
  enabled = true,
}: UseEntityLimitParams) {
  const { data: existingLimits = [] } = useLimits(
    enabled && entityId ? { entityType, entityId } : undefined,
  );

  const existingLimit = useMemo(() => {
    return existingLimits.find((l) => l.limitType === "token_cost");
  }, [existingLimits]);

  const [state, setState] = useState<EntityLimitFormState>(
    DEFAULT_ENTITY_LIMIT_STATE,
  );

  useEffect(() => {
    if (existingLimit) {
      const models = Array.isArray(existingLimit.model)
        ? existingLimit.model.filter((m): m is string => typeof m === "string")
        : [];
      const isAllModels =
        models.length === 0 && existingLimit.limitType === "token_cost";

      setState({
        enabled: true,
        limitValue: String(existingLimit.limitValue),
        cleanupInterval:
          (existingLimit.cleanupInterval as LimitCleanupInterval) ??
          DEFAULT_LIMIT_CLEANUP_INTERVAL,
        models: isAllModels ? [] : models,
        isAllModels,
      });
    } else {
      setState(DEFAULT_ENTITY_LIMIT_STATE);
    }
  }, [existingLimit]);

  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();

  const saveLimit = useCallback(
    async (targetEntityId: string) => {
      if (!state.enabled || !state.limitValue) {
        return;
      }

      const body = {
        entityType,
        entityId: targetEntityId,
        limitType: "token_cost" as const,
        limitValue: Number(state.limitValue),
        cleanupInterval: state.cleanupInterval,
        model: state.isAllModels ? null : state.models,
      };

      if (existingLimit) {
        return await updateLimit.mutateAsync({
          id: existingLimit.id,
          ...body,
        });
      }

      return await createLimit.mutateAsync(body);
    },
    [state, entityType, existingLimit, createLimit, updateLimit],
  );

  return {
    state,
    setState,
    existingLimit,
    saveLimit,
    isPending: createLimit.isPending || updateLimit.isPending,
  };
}
