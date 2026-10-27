"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useModelPools } from "@/lib/model-pools.query";

/**
 * Whether a virtual key form shows {@link ModelPoolsField}: the feature is on
 * and the caller may change which keys reach a pool.
 */
export function useCanSetModelPools(): boolean {
  const enabled = useFeature("llmModelPoolsEnabled") === true;
  const { data: canUpdateModels } = useHasPermissions({
    llmModel: ["update"],
  });
  return enabled && canUpdateModels === true;
}

/**
 * The pools a virtual key or OAuth client may call by name, beyond the ones
 * its provider keys reach.
 */
export function ModelPoolsField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const id = useId();
  const { data: pools = [] } = useModelPools();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Model pools</Label>
      <p className="text-sm text-muted-foreground">
        <span>
          Pools this credential can call by name. It can already call any pool
          that uses one of its provider keys.
        </span>
      </p>
      <MultiSelectCombobox
        id={id}
        ariaLabel="Model pools"
        options={pools.map((pool) => ({ value: pool.id, label: pool.name }))}
        // A deleted pool can stay listed on an OAuth client until it is saved.
        value={value.filter((poolId) =>
          pools.some((pool) => pool.id === poolId),
        )}
        onChange={onChange}
        placeholder="Search pools..."
        emptyMessage="No model pools yet."
      />
    </div>
  );
}
