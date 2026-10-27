"use client";

import { DocsPage, type SupportedProvider } from "@archestra/shared";
import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  type UniqueIdentifier,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  type SortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  CircleAlert,
  CircleHelp,
  GripVertical,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Controller } from "react-hook-form";
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
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
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
  isValidWeight,
  MAX_WEIGHT,
  type PoolForm,
  type PoolOptions,
} from "./pool-form";
import {
  type OrderBucket,
  type OrderMember,
  useOrderBuckets,
} from "./use-order-buckets";

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

// Handle, key, model, weight, traffic, on, remove.
const MEMBER_COLUMNS =
  "@3xl:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1.25fr)_4rem_4.5rem_2.75rem_2.25rem]";

type MembersEditorProps = {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  /** The saved members, with live cooldowns. Empty for a new pool. */
  savedMembers: SavedMember[];
};

type DropTarget =
  | { kind: "order"; order: number; position?: number }
  | { kind: "gap"; before: number }
  | { kind: "new" };

/** What a drop on `id` means: a card, a gap between cards, or a member row. */
function dropTarget(
  id: UniqueIdentifier,
  buckets: OrderBucket[],
): DropTarget | null {
  const key = String(id);
  if (key === "zone:new") return { kind: "new" };
  if (key.startsWith("zone:order:")) {
    return { kind: "order", order: Number(key.slice("zone:order:".length)) };
  }
  if (key.startsWith("zone:gap:")) {
    return { kind: "gap", before: Number(key.slice("zone:gap:".length)) };
  }
  for (const bucket of buckets) {
    const position = bucket.members.findIndex((member) => member.id === key);
    if (position >= 0) return { kind: "order", order: bucket.order, position };
  }
  return null;
}

// A member row under the pointer wins over the card that holds it.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const pool = hits.length > 0 ? hits : closestCenter(args);
  const first =
    pool.find((hit) => !String(hit.id).startsWith("zone:")) ?? pool[0];
  return first ? [first] : [];
};

// Rows only make room for the dragged member inside its own card.
const withinOrder: SortingStrategy = (args) =>
  args.activeIndex < 0 || args.overIndex < 0
    ? null
    : verticalListSortingStrategy(args);

/**
 * The members as one card per order. Requests try order 1 first; members of
 * an order split its traffic by weight. Drag a member into another card, or
 * between two cards to give it an order of its own.
 */
export function MembersEditor(props: MembersEditorProps) {
  const { disabled, options } = props;
  const editor = useOrderBuckets(props);
  const { buckets, count, canAdd } = editor;
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const members = buckets.flatMap((bucket) => bucket.members);
  const active = members.find((member) => member.id === activeId) ?? null;
  const dragging = active !== null;
  const target = overId === null ? null : dropTarget(overId, buckets);
  const canDrag = !disabled && count > 1;

  const endDrag = () => {
    setActiveId(null);
    setOverId(null);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    endDrag();
    const from = members.find((member) => member.id === active.id)?.index;
    if (from === undefined || !over || over.id === active.id) return;
    const drop = dropTarget(over.id, buckets);
    if (drop?.kind === "order") {
      editor.moveToOrder(from, drop.order, drop.position);
    }
    if (drop?.kind === "gap") editor.moveToNewOrderBefore(from, drop.before);
    if (drop?.kind === "new") editor.moveToOrder(from, buckets.length + 1);
  };

  return (
    <div className="@container space-y-2">
      <div className="space-y-0.5">
        <Label>Members</Label>
        {count > 0 ? (
          <p className="text-xs text-muted-foreground">
            Order 1 is tried first. Members of an order split its traffic by
            weight.
          </p>
        ) : null}
      </div>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add the provider keys that serve this model.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={({ active }) => setActiveId(active.id)}
          onDragOver={({ over }) => setOverId(over?.id ?? null)}
          onDragEnd={handleDragEnd}
          onDragCancel={endDrag}
        >
          {/* One block, so the parent's spacing doesn't part connectors from cards. */}
          <div>
            <DropSlot
              id="zone:gap:1"
              active={dragging}
              label="Drop here for a new order 1"
            />
            {buckets.map((bucket) => (
              <div key={bucket.order}>
                {bucket.order > 1 ? (
                  <DropSlot
                    id={`zone:gap:${bucket.order}`}
                    active={dragging}
                    label={`Drop here for a new order between ${bucket.order - 1} and ${bucket.order}`}
                  >
                    <div className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className="ml-[22px] h-full w-px bg-border"
                        aria-hidden="true"
                      />
                      <ArrowDown className="size-3.5" aria-hidden="true" />
                      <span>If every member above is unavailable</span>
                    </div>
                  </DropSlot>
                ) : null}
                <OrderCard
                  bucket={bucket}
                  editor={props}
                  canDrag={canDrag}
                  canAdd={canAdd}
                  highlighted={
                    dragging &&
                    target?.kind === "order" &&
                    target.order === bucket.order
                  }
                  onAdd={() => editor.addToOrder(bucket.order)}
                  onRemove={editor.removeAt}
                />
              </div>
            ))}
            <DragOverlay dropAnimation={null}>
              {active ? (
                <DragPreview member={active} options={options} />
              ) : null}
            </DragOverlay>
            <div className="pt-2">
              <DropSlot
                id="zone:new"
                active={dragging}
                label="Drop here for a new order"
              >
                <AddOrder
                  count={count}
                  canAdd={canAdd}
                  disabled={disabled}
                  onAdd={() => editor.addToOrder(buckets.length + 1)}
                />
              </DropSlot>
            </div>
          </div>
        </DndContext>
      )}
      {count === 0 ? (
        <AddOrder
          count={count}
          canAdd={canAdd}
          disabled={disabled}
          onAdd={() => editor.addToOrder(1)}
        />
      ) : null}
    </div>
  );
}

function AddOrder({
  count,
  canAdd,
  disabled,
  onAdd,
}: {
  count: number;
  canAdd: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || !canAdd}
        onClick={onAdd}
      >
        <Plus />
        <span>{count === 0 ? "Add member" : "Add order"}</span>
      </Button>
      {canAdd ? null : (
        <span className="text-xs text-muted-foreground">
          No shared provider keys yet.
        </span>
      )}
    </div>
  );
}

/** A drop target that shows its normal content until a drag starts. */
function DropSlot({
  id,
  active,
  label,
  children,
}: {
  id: string;
  active: boolean;
  label: string;
  children?: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef}>
      {active ? (
        <div
          className={cn(
            "my-0.5 flex h-7 items-center justify-center gap-1.5 rounded-md border border-dashed text-xs text-muted-foreground transition-colors",
            isOver && "border-primary bg-primary/5 text-primary",
          )}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          <span>{label}</span>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function OrderCard({
  bucket,
  editor,
  canDrag,
  canAdd,
  highlighted,
  onAdd,
  onRemove,
}: {
  bucket: OrderBucket;
  editor: MembersEditorProps;
  canDrag: boolean;
  canAdd: boolean;
  highlighted: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const { order, members } = bucket;
  const { setNodeRef } = useDroppable({ id: `zone:order:${order}` });
  const shared = members.length > 1;

  return (
    <section
      ref={setNodeRef}
      aria-label={`Order ${order}`}
      className={cn(
        "rounded-lg border bg-card transition-colors",
        order === 1 && "border-primary/30",
        highlighted && "border-primary bg-primary/5 ring-2 ring-primary/20",
      )}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
            order === 1
              ? "bg-primary text-primary-foreground"
              : "border bg-muted text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {order}
        </span>
        <span className="text-sm font-medium">Order {order}</span>
      </header>
      <ColumnHeaders shared={shared} />
      <SortableContext
        items={members.map((member) => member.id)}
        strategy={withinOrder}
      >
        <ul className="divide-y">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              row={member}
              order={order}
              editor={editor}
              shared={shared}
              canDrag={canDrag}
              onRemove={() => onRemove(member.index)}
            />
          ))}
        </ul>
      </SortableContext>
      <div className="border-t px-2 py-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Add member to order ${order}`}
          disabled={editor.disabled || !canAdd}
          onClick={onAdd}
          className="text-muted-foreground"
        >
          <Plus />
          <span>Add member</span>
        </Button>
      </div>
    </section>
  );
}

/**
 * The label strip under a card's title, on the rows' grid so each label sits
 * over its field. Weight and Traffic stay blank in a one-member order. In a
 * narrow dialog the rows label their own controls instead.
 */
function ColumnHeaders({ shared }: { shared: boolean }) {
  return (
    <div
      className={cn(
        "hidden h-7 items-center gap-2 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground @3xl:grid",
        MEMBER_COLUMNS,
      )}
    >
      <span />
      <span>Provider key</span>
      <span>Model</span>
      {shared ? (
        <span className="flex items-center gap-1">
          Weight
          <HelpTip topic="Weight">
            Splits an order&apos;s traffic between its members. 3 and 1 means
            75% and 25%.
          </HelpTip>
        </span>
      ) : (
        <span />
      )}
      {shared ? <span>Traffic</span> : <span />}
      <span className="flex items-center gap-1">
        On
        <HelpTip topic="On">
          Off keeps the member but sends it no traffic.
        </HelpTip>
      </span>
      <span />
    </div>
  );
}

// Outlines the key and model pickers of a repeated member.
const INVALID_FIELD =
  "[&_button]:border-destructive [&_button]:ring-2 [&_button]:ring-destructive/20 dark:[&_button]:ring-destructive/40";

function MemberRow({
  row,
  order,
  editor,
  shared,
  canDrag,
  onRemove,
}: {
  row: OrderMember;
  order: number;
  editor: MembersEditorProps;
  /** Other members share this order. */
  shared: boolean;
  canDrag: boolean;
  onRemove: () => void;
}) {
  const { form, options, disabled } = editor;
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

/** The chip that follows the pointer while a member is dragged. */
function DragPreview({
  member,
  options,
}: {
  member: OrderMember;
  options: PoolOptions;
}) {
  const key = options.keysById.get(member.member.providerApiKeyId);
  return (
    <div className="flex w-fit max-w-80 cursor-grabbing items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm shadow-lg">
      <GripVertical
        className="size-4 text-muted-foreground"
        aria-hidden="true"
      />
      {key ? <ProviderIcon provider={key.provider} size={14} /> : null}
      <span className="truncate">{key?.name ?? "Provider key"}</span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {member.member.modelId}
      </span>
    </div>
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
  return (
    <span className="truncate">
      {poolProviders(pool)
        .map((provider) => catalog.label(provider))
        .join(", ")}
    </span>
  );
}

/** The pool's providers as overlapping logos, to tell pools apart at a glance. */
export function PoolProviderIcons({ pool }: { pool: ModelPool }) {
  const catalog = useModelProviderCatalog();
  return (
    <OverlappedIcons
      className="w-14 shrink-0 -space-x-2"
      maxVisible={2}
      itemClassName="size-6"
      icons={poolProviders(pool).map((provider) => ({
        key: provider,
        icon: <ProviderIcon provider={provider} size={14} />,
        tooltip: catalog.label(provider),
      }))}
    />
  );
}

function poolProviders(pool: ModelPool): SupportedProvider[] {
  return [
    ...new Set(
      pool.members.map((member) => member.provider as SupportedProvider),
    ),
  ];
}
