"use client";

import { useState } from "react";
import {
  LabelKeyRowBase,
  LabelSelect,
  type LabelSelectProps,
} from "@/components/label-select";

interface EntityLabelFilterProps {
  /** The entity's label-keys hook, from `createEntityLabelQueries`. */
  useLabelKeys: () => { data: string[] | undefined };
  /** The entity's label-values hook, from `createEntityLabelQueries`. */
  useLabelValues: (params?: { key?: string }) => { data: string[] | undefined };
  className?: LabelSelectProps["className"];
}

/**
 * The `?labels=` filter control for one entity's list page.
 *
 * `LabelSelect` takes the per-key row as a component so each key's values can
 * be fetched lazily; that row is identical for every entity once its hooks are
 * known, so it is built here rather than redeclared on each page.
 */
export function EntityLabelFilter({
  useLabelKeys,
  useLabelValues,
  className,
}: EntityLabelFilterProps) {
  const { data: labelKeys } = useLabelKeys();

  function LabelKeyRow({
    labelKey,
    selectedValues,
    onToggleValue,
  }: {
    labelKey: string;
    selectedValues: string[];
    onToggleValue: (key: string, value: string) => void;
  }) {
    // Values load only once this key's sub-popover opens.
    const [open, setOpen] = useState(false);
    const { data: values } = useLabelValues({
      key: open ? labelKey : undefined,
    });
    return (
      <LabelKeyRowBase
        labelKey={labelKey}
        selectedValues={selectedValues}
        onToggleValue={onToggleValue}
        values={values}
        onOpenChange={setOpen}
      />
    );
  }

  return (
    <LabelSelect
      labelKeys={labelKeys}
      LabelKeyRowComponent={LabelKeyRow}
      className={className}
    />
  );
}
