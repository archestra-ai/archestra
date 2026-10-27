"use client";

import { DocsPage, type SupportedProvider } from "@archestra/shared";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CircleHelp,
  GripVertical,
  Info,
  Link2,
  Plus,
  TriangleAlert,
  Unlink2,
  X,
} from "lucide-react";
import { useState } from "react";
import { Controller, useFieldArray } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  LlmModelSearchableSelect,
  type LlmModelSelectOption,
} from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import type { ModelPool } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";
import { MemberCooldown } from "./member-status";
import { poolModelName, suggestModelId } from "./model-name";
import {
  hasRepeatedMember,
  isValidWeight,
  MAX_WEIGHT,
  memberOrders,
  moveMember,
  orderShare,
  type PoolForm,
  type PoolFormMember,
  type PoolOptions,
  removeMember,
} from "./pool-form";

type SavedMember = ModelPool["members"][number];

export function ModelNameField({
  form,
  options,
  disabled,
  taken,
}: {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  taken: boolean;
}) {
  return (
    <div className="space-y-2">
      <span className="flex items-center gap-1.5">
        <Label htmlFor="pool-name">Model name</Label>
        <HelpTip topic="Model name">
          The model name clients ask for, e.g. in Claude Code or the OpenAI SDK.
        </HelpTip>
      </span>
      <Controller
        control={form.control}
        name="name"
        render={({ field }) => (
          <SearchableSelect
            id="pool-name"
            value={field.value}
            onValueChange={(value) => {
              field.onChange(value);
              // Members still on the old name follow the new one.
              form.setValue(
                "members",
                form.getValues("members").map((member) =>
                  !member.modelId || member.modelId === field.value
                    ? {
                        ...member,
                        modelId: suggestModelId(
                          value,
                          options.keysById.get(member.providerApiKeyId)
                            ?.provider,
                          options.modelIdsByKey.get(member.providerApiKeyId),
                        ),
                      }
                    : member,
                ),
                { shouldDirty: true },
              );
            }}
            disabled={disabled}
            placeholder="e.g. glm-5"
            ariaLabel="Model name"
            searchPlaceholder="Search or type a model name"
            allowCustom
            className="w-full font-mono"
            items={options.modelNames.map((value) => ({ value, label: value }))}
          />
        )}
      />
      {taken ? (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">This name already has a pool</span>
          <InlineNoticeText>Add the members there instead.</InlineNoticeText>
        </InlineNotice>
      ) : null}
    </div>
  );
}

// Order, key, model, weight, traffic, on, remove.
const MEMBER_COLUMNS =
  "@3xl:grid-cols-[4.25rem_minmax(0,1fr)_minmax(0,1.25fr)_4.5rem_4.5rem_3.25rem_2.25rem]";

/**
 * The members in the order requests try them. Drag a row to change its order;
 * link it to the row above to share that order and split traffic by weight.
 * In a wide dialog each row is one line under column headers; in a narrow one
 * it wraps.
 */
export function MembersEditor({
  form,
  options,
  disabled,
  savedMembers,
}: {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  /** The saved members, with live cooldowns. Empty for a new pool. */
  savedMembers: SavedMember[];
}) {
  const { fields, append, move, remove } = useFieldArray({
    control: form.control,
    name: "members",
  });
  const name = form.watch("name").trim();
  const members = form.watch("members");
  const orders = memberOrders(members);
  const { sharedKeys, modelIdsByKey } = options;
  const nextKey =
    sharedKeys.find(
      (key) => !members.some((member) => member.providerApiKeyId === key.id),
    ) ?? sharedKeys[0];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // The field array moves and removes rows; which rows are linked follows.
  const relink = (next: PoolFormMember[]) => {
    next.forEach((member, index) => {
      if (form.getValues(`members.${index}.linked`) !== member.linked) {
        form.setValue(`members.${index}.linked`, member.linked, {
          shouldDirty: true,
        });
      }
    });
  };
  const moveRow = (from: number, to: number) => {
    if (from === to || to < 0 || to >= fields.length) return;
    const next = moveMember(form.getValues("members"), from, to);
    move(from, to);
    relink(next);
  };
  const removeRow = (index: number) => {
    const next = removeMember(form.getValues("members"), index);
    remove(index);
    relink(next);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    moveRow(
      fields.findIndex((field) => field.id === active.id),
      fields.findIndex((field) => field.id === over.id),
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label>Members</Label>
        {fields.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            Tried top to bottom. Link rows to split traffic by weight.
          </span>
        ) : null}
      </div>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add the provider keys that serve this model.
        </p>
      ) : (
        <div className="@container rounded-md border">
          <div
            className={cn(
              "hidden gap-2 border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground @3xl:grid",
              MEMBER_COLUMNS,
            )}
          >
            <span>Order</span>
            <span>Provider key</span>
            <span>Model</span>
            <span className="flex items-center gap-1">
              Weight
              <HelpTip topic="Weight">
                Splits traffic between linked rows. 3 and 1 means 75% and 25%.
              </HelpTip>
            </span>
            <span>Traffic</span>
            <span className="flex items-center gap-1">
              On
              <HelpTip topic="On">
                Off keeps the member but sends it no traffic.
              </HelpTip>
            </span>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={fields.map((field) => field.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul>
                {fields.map((field, index) => {
                  const member = members[index];
                  if (!member) return null;
                  const order = orders[index] ?? 1;
                  const shared =
                    orders.filter((other) => other === order).length > 1;
                  return (
                    <MemberRow
                      key={field.id}
                      fieldId={field.id}
                      form={form}
                      options={options}
                      disabled={disabled}
                      index={index}
                      count={fields.length}
                      member={member}
                      order={order}
                      shared={shared}
                      share={orderShare(members, index)}
                      poolName={name}
                      saved={
                        savedMembers.find(
                          (row) =>
                            row.providerApiKeyId === member.providerApiKeyId &&
                            row.modelId === member.modelId,
                        ) ?? null
                      }
                      onMove={moveRow}
                      onRemove={() => removeRow(index)}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !nextKey}
          onClick={() =>
            nextKey &&
            append({
              providerApiKeyId: nextKey.id,
              modelId: suggestModelId(
                name,
                nextKey.provider,
                modelIdsByKey.get(nextKey.id),
              ),
              linked: false,
              weight: 1,
              enabled: true,
            })
          }
        >
          <Plus />
          <span>Add member</span>
        </Button>
        {sharedKeys.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            No shared provider keys yet.
          </span>
        ) : null}
        {hasRepeatedMember(members) ? (
          <span className="text-xs text-destructive">
            A key and model ID can be a member only once.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MemberRow({
  fieldId,
  form,
  options,
  disabled,
  index,
  count,
  member,
  order,
  shared,
  share,
  poolName,
  saved,
  onMove,
  onRemove,
}: {
  fieldId: string;
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  index: number;
  count: number;
  member: PoolFormMember;
  order: number;
  /** Other members share this order. */
  shared: boolean;
  share: number | null;
  poolName: string;
  saved: SavedMember | null;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: fieldId, disabled: disabled || count < 2 });
  const [keyOpen, setKeyOpen] = useState(false);
  const { sharedKeys, keysById, modelIdsByKey, modelIdsByProvider } = options;
  const provider = keysById.get(member.providerApiKeyId)?.provider;
  const keyModels = modelIdsByKey.get(member.providerApiKeyId) ?? [];
  const modelOptions = toModelOptions({
    provider,
    keyModels,
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

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 bg-background px-3 py-2.5",
        MEMBER_COLUMNS,
        index > 0 && !member.linked && "border-t",
        isDragging && "z-10 opacity-70 shadow-md",
      )}
    >
      <div className="flex h-9 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Drag member ${index + 1}`}
          className="cursor-grab text-muted-foreground active:cursor-grabbing"
          disabled={disabled || count < 2}
          {...attributes}
          {...listeners}
          onKeyDown={(event) => {
            listeners?.onKeyDown?.(event);
            if (event.key === "ArrowUp") {
              event.preventDefault();
              onMove(index, index - 1);
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              onMove(index, index + 1);
            }
          }}
        >
          <GripVertical />
        </Button>
        <span
          role="img"
          aria-label={`Order ${order}`}
          className={cn(
            "flex size-5 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums",
            shared
              ? "border-primary/40 bg-primary/10 text-primary"
              : "bg-muted",
          )}
        >
          {order}
        </span>
      </div>
      {index > 0 ? (
        <LinkToggle
          linked={member.linked}
          disabled={disabled}
          onToggle={() =>
            form.setValue(`members.${index}.linked`, !member.linked, {
              shouldDirty: true,
            })
          }
        />
      ) : null}
      <div className="grid min-w-0 gap-2 @3xl:contents">
        <div className="min-w-0 space-y-1">
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
          <MemberCooldown saved={saved} />
        </div>
        <div className="min-w-0 space-y-1">
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
          {provider === "bedrock" ? (
            <p className="flex items-center gap-1 pl-1 text-[11px] text-muted-foreground">
              <Info className="size-3 shrink-0" aria-hidden="true" />
              <span>Claude Code skips Bedrock members.</span>
            </p>
          ) : null}
          {otherModel ? (
            <p className="flex items-center gap-1 pl-1 text-[11px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
              <span>Not the same model as {poolName}.</span>
            </p>
          ) : null}
        </div>
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
            <span className="hidden h-9 items-center pl-2 text-xs text-muted-foreground @3xl:flex">
              —
            </span>
          )}
          <TrafficShare
            share={share}
            label={!member.enabled ? "Off" : order === 1 ? "All" : "Fallback"}
          />
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
 * The chip on the line above a row: linked shares the order of the row above
 * and splits its traffic; unlinked makes the row a fallback for it.
 */
function LinkToggle({
  linked,
  disabled,
  onToggle,
}: {
  linked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={
            linked
              ? "Stop sharing the order of the row above"
              : "Share the order of the row above"
          }
          aria-pressed={linked}
          disabled={disabled}
          onClick={onToggle}
          className={cn(
            "absolute -top-2.5 left-[2.75rem] z-10 flex size-5 items-center justify-center rounded-full border bg-background disabled:pointer-events-none",
            linked
              ? "border-primary/50 text-primary"
              : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {linked ? (
            <Link2 className="size-3" aria-hidden="true" />
          ) : (
            <Unlink2 className="size-3" aria-hidden="true" />
          )}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent>
        {linked
          ? "Same order as the row above. Click to make it a fallback."
          : "Fallback for the rows above. Click to split traffic with the row above."}
      </TooltipContent>
    </Tooltip>
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

/** The member's percent of its order's traffic, with a bar. */
function TrafficShare({
  share,
  label,
}: {
  share: number | null;
  /** Shown instead of a percent when the member is off or alone. */
  label: string;
}) {
  if (share === null) {
    return (
      <span className="flex h-9 items-center text-xs text-muted-foreground">
        {label}
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

/** A "?" beside a label that explains it in one or two sentences. */
function HelpTip({
  topic,
  children,
}: {
  topic: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`About ${topic}`}
          className="inline-flex text-muted-foreground hover:text-foreground"
          onFocus={(event) => {
            // A dialog focuses its first control on open; only keyboard
            // focus should open the tip.
            if (!event.currentTarget.matches(":focus-visible")) {
              event.preventDefault();
            }
          }}
        >
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{children}</TooltipContent>
    </Tooltip>
  );
}

/** What happens when a member fails, in one line, with the rules in the docs. */
export function FailoverNote() {
  return (
    <p className="text-xs text-muted-foreground">
      <span>
        A member that answers 429, 5xx or times out is skipped and cools down
        for up to 60 s.
      </span>{" "}
      <ExternalDocsLink
        href={getFrontendDocsUrl(
          DocsPage.PlatformLlmProxyModelPools,
          "how-failover-works",
        )}
        showIcon={false}
        className="underline"
      >
        How failover works
      </ExternalDocsLink>
    </p>
  );
}

/** The providers a pool's members are on, as icons. */
export function PoolProviders({ pool }: { pool: ModelPool }) {
  const catalog = useModelProviderCatalog();
  const providers = [
    ...new Set(
      pool.members.map((member) => member.provider as SupportedProvider),
    ),
  ];
  return (
    <span className="flex items-center gap-1.5">
      {providers.map((provider) => (
        <ProviderIcon key={provider} provider={provider} />
      ))}
      <span className="truncate">
        {providers.map((provider) => catalog.label(provider)).join(", ")}
      </span>
    </span>
  );
}
