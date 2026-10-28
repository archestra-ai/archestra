"use client";

import type { SupportedProvider } from "@archestra/shared";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CircleAlert, GripVertical, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Controller } from "react-hook-form";
import {
  LlmModelSearchableSelect,
  type LlmModelSelectOption,
} from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils/tailwind";
import { MemberCooldown } from "./member-status";
import { poolModelName, suggestModelId } from "./model-name";
import {
  isValidWeight,
  MAX_WEIGHT,
  type PoolForm,
  type PoolOptions,
  type SavedMember,
} from "./pool-form";
import type { OrderMember } from "./use-order-buckets";

// Handle, key, model, weight, traffic, on, remove.
export const MEMBER_COLUMNS =
  "@3xl:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1.25fr)_4rem_4.5rem_2.75rem_2.25rem]";

export type MemberFields = {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  /** The saved members, with live cooldowns. Empty for a new pool. */
  savedMembers: SavedMember[];
};

// Outlines the key and model pickers of a repeated member.
const INVALID_FIELD =
  "[&_button]:border-destructive [&_button]:ring-2 [&_button]:ring-destructive/20 dark:[&_button]:ring-destructive/40";

export function MemberRow({
  row,
  order,
  fields,
  shared,
  canDrag,
  onRemove,
}: {
  row: OrderMember;
  order: number;
  fields: MemberFields;
  /** Other members share this order. */
  shared: boolean;
  canDrag: boolean;
  onRemove: () => void;
}) {
  const { form, options, disabled } = fields;
  const { index, member, repeatsOrder } = row;
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: row.id, disabled: !canDrag });
  const [keyOpen, setKeyOpen] = useState(false);
  const { sharedKeys, keysById, modelIdsByKey, modelIdsByProvider } = options;
  const poolName = form.watch("name").trim();
  const provider = keysById.get(member.providerApiKeyId)?.provider;
  const modelOptions = toModelOptions({
    provider,
    keyModels: modelIdsByKey.get(member.providerApiKeyId) ?? [],
    providerModels: provider ? (modelIdsByProvider.get(provider) ?? []) : [],
  });
  const modelName = provider
    ? poolModelName(provider, member.modelId)
    : member.modelId;
  // Only warn when both names are ones the catalog knows: a typed id or a
  // pool named after no model says nothing either way.
  const otherModel =
    member.modelId.trim() !== "" &&
    options.modelNames.includes(poolName) &&
    options.modelNames.includes(modelName) &&
    modelName !== poolName;
  const repeated = repeatsOrder !== null;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 bg-card px-3 py-2.5",
        MEMBER_COLUMNS,
        isDragging && "opacity-40",
      )}
    >
      <div className="flex h-9 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Drag into another order"
          className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
          disabled={!canDrag}
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </Button>
      </div>
      <div className="grid min-w-0 gap-2 @3xl:contents">
        <div className={cn("min-w-0 space-y-1", repeated && INVALID_FIELD)}>
          <LlmProviderApiKeyDropdown
            availableKeys={sharedKeys}
            selectedApiKeyId={member.providerApiKeyId || null}
            open={keyOpen}
            onOpenChange={setKeyOpen}
            disabled={disabled}
            onSelectKey={(keyId) => {
              form.setValue(`members.${index}.providerApiKeyId`, keyId, {
                shouldDirty: true,
              });
              form.setValue(
                `members.${index}.modelId`,
                suggestModelId(
                  poolName,
                  keysById.get(keyId)?.provider,
                  modelIdsByKey.get(keyId),
                ),
                { shouldDirty: true },
              );
            }}
            triggerVariant="select"
            triggerClassName="w-full"
            triggerAriaLabel="Provider key"
          />
          <MemberCooldown saved={row.saved} />
        </div>
        <div className="min-w-0 space-y-1">
          <div className={cn(repeated && INVALID_FIELD)}>
            <Controller
              control={form.control}
              name={`members.${index}.modelId`}
              render={({ field }) => (
                <LlmModelSearchableSelect
                  options={modelOptions}
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={disabled || !member.providerApiKeyId}
                  allowCustom
                  placeholder="Choose or type a model ID"
                  searchPlaceholder="Search or type a model ID"
                  emptyMessage="This key has no synced models. Type the model ID."
                  className="font-mono"
                  popoverContentClassName="w-[400px]"
                  popoverAlign="start"
                />
              )}
            />
          </div>
          {otherModel ? (
            <p className="flex items-center gap-1 pl-1 text-[11px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
              <span>Not the same model as {poolName}.</span>
            </p>
          ) : null}
        </div>
        {repeated ? (
          // Wide: its own line under the key and model, so the rest of the
          // row keeps its cells.
          <p className="flex items-center gap-1.5 text-xs text-destructive @3xl:col-span-2 @3xl:col-start-2 @3xl:row-start-2 @3xl:-mt-1">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {repeatsOrder === order
                ? "Already in this order with this key and model."
                : `Already in order ${repeatsOrder} with this key and model.`}
            </span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 @3xl:contents">
          {shared ? (
            <Label className="gap-1.5 text-xs font-normal text-muted-foreground">
              <span className="@3xl:sr-only">Weight</span>
              <Input
                type="number"
                min={1}
                max={MAX_WEIGHT}
                className="w-16 font-mono @3xl:w-full"
                disabled={disabled}
                aria-invalid={!isValidWeight(member.weight)}
                {...form.register(`members.${index}.weight`, {
                  valueAsNumber: true,
                })}
              />
            </Label>
          ) : (
            <span className="hidden @3xl:block" />
          )}
          {shared ? (
            <TrafficShare share={row.share} />
          ) : (
            <span className="hidden @3xl:block" />
          )}
          <Controller
            control={form.control}
            name={`members.${index}.enabled`}
            render={({ field }) => (
              <span className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={disabled}
                  aria-label="Member on"
                />
                <span className="@3xl:sr-only">On</span>
              </span>
            )}
          />
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Remove member"
        disabled={disabled}
        onClick={onRemove}
      >
        <X />
      </Button>
    </li>
  );
}

/**
 * The model ids a member can pick: the ones its key has synced, or, when it
 * has synced none, every one its provider's keys list, marked as such.
 */
function toModelOptions({
  provider,
  keyModels,
  providerModels,
}: {
  provider: SupportedProvider | undefined;
  keyModels: string[];
  providerModels: string[];
}): LlmModelSelectOption[] {
  if (!provider) return [];
  const unsynced = keyModels.length === 0;
  return (unsynced ? providerModels : keyModels).map((modelId) => ({
    value: modelId,
    model: modelId,
    provider,
    badge: unsynced ? "Not synced" : undefined,
  }));
}

/** The member's percent of its order's traffic, with a bar; "Off" when off. */
function TrafficShare({ share }: { share: number | null }) {
  if (share === null) {
    return (
      <span className="flex h-9 items-center text-xs text-muted-foreground">
        Off
      </span>
    );
  }
  return (
    <span className="grid h-9 w-16 content-center gap-1 text-xs tabular-nums @3xl:w-full">
      <span>{share}%</span>
      <span className="h-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${share}%` }}
        />
      </span>
    </span>
  );
}
