"use client";

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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowDown,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
  Plus,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { MEMBER_COLUMNS, type MemberFields, MemberRow } from "./member-row";
import { FoldedCooldown } from "./member-status";
import { HelpTip } from "./pool-fields";
import { isValidWeight, type PoolOptions } from "./pool-form";
import {
  type OrderBucket,
  type OrderMember,
  useOrderBuckets,
} from "./use-order-buckets";

type DropTarget =
  | { kind: "order"; order: number; position?: number }
  | { kind: "gap"; before: number };

/** What a drop on `id` means: a card, a gap between cards, or a member row. */
function dropTarget(
  id: UniqueIdentifier,
  buckets: OrderBucket[],
): DropTarget | null {
  const key = String(id);
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

/** Above this many members, the orders after the first open folded. */
const FOLD_ABOVE = 4;

// Rows only make room for the dragged member inside its own card.
const withinOrder: SortingStrategy = (args) =>
  args.activeIndex < 0 || args.overIndex < 0
    ? null
    : verticalListSortingStrategy(args);

/**
 * The members as one card per order. Requests try order 1 first; members of
 * an order split its traffic by weight. Drag a member into another card, or
 * between two cards to give it an order of its own. An order folds to its
 * header, so a big pool's later settings stay in reach.
 */
export function MembersEditor(props: MemberFields) {
  const { disabled, options } = props;
  const orders = useOrderBuckets(props);
  const { buckets, count, canAdd } = orders;
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  // Folding goes by member, not order number, so it survives orders being
  // renumbered, and an order a member is added or dragged into opens.
  const [foldedIds, setFoldedIds] = useState(
    () =>
      new Set(
        count > FOLD_ABOVE
          ? buckets.slice(1).flatMap((bucket) => idsOf(bucket))
          : [],
      ),
  );
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
  // A single order has nothing to fold away from.
  const canFold = buckets.length > 1;
  // An order can't fold while a member keeps Save off, so the fix stays in
  // view, and it stays open once fixed.
  const canFoldOrder = (bucket: OrderBucket) =>
    canFold && !bucket.members.some(needsFixing);
  const isFolded = (bucket: OrderBucket) =>
    canFoldOrder(bucket) && idsOf(bucket).every((id) => foldedIds.has(id));
  const anyFolded = buckets.some(isFolded);
  const setFolded = (bucket: OrderBucket, folded: boolean) => {
    const next = new Set(foldedIds);
    for (const id of idsOf(bucket)) {
      if (folded) next.add(id);
      else next.delete(id);
    }
    setFoldedIds(next);
  };

  const addOrder = (
    <AddOrder
      count={count}
      canAdd={canAdd}
      disabled={disabled}
      onAdd={() => orders.addToOrder(buckets.length + 1)}
    />
  );

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
      orders.moveToOrder(from, drop.order, drop.position);
    }
    if (drop?.kind === "gap") orders.moveToNewOrderBefore(from, drop.before);
  };

  return (
    <div className="@container space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <Label>Members</Label>
          {count > 0 ? (
            <p className="text-xs text-muted-foreground">
              Order 1 is tried first. Members of an order split its traffic by
              weight.
            </p>
          ) : null}
        </div>
        {canFold ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-mt-1 text-muted-foreground"
            onClick={() =>
              setFoldedIds(
                new Set(
                  anyFolded ? [] : buckets.filter(canFoldOrder).flatMap(idsOf),
                ),
              )
            }
          >
            {anyFolded ? (
              <ChevronsUpDown aria-hidden="true" />
            ) : (
              <ChevronsDownUp aria-hidden="true" />
            )}
            <span>{anyFolded ? "Expand all" : "Collapse all"}</span>
          </Button>
        ) : null}
      </div>
      {count === 0 ? (
        <>
          <p className="text-sm text-muted-foreground">
            Add the provider keys that serve this model.
          </p>
          {addOrder}
        </>
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
                  fields={props}
                  canDrag={canDrag}
                  canAdd={canAdd}
                  canFold={canFoldOrder(bucket)}
                  folded={isFolded(bucket)}
                  onFold={(folded) => setFolded(bucket, folded)}
                  highlighted={
                    dragging &&
                    target?.kind === "order" &&
                    target.order === bucket.order
                  }
                  onAdd={() => orders.addToOrder(bucket.order)}
                  onRemove={orders.removeAt}
                />
              </div>
            ))}
            <DragOverlay dropAnimation={null}>
              {active ? (
                <DragPreview member={active} options={options} />
              ) : null}
            </DragOverlay>
            <div className="pt-2">
              {/* Past the last card: a drop here makes a new last order. */}
              <DropSlot
                id={`zone:gap:${buckets.length + 1}`}
                active={dragging}
                label="Drop here for a new order"
              >
                {addOrder}
              </DropSlot>
            </div>
          </div>
        </DndContext>
      )}
    </div>
  );
}

function needsFixing({ member, repeatsOrder }: OrderMember): boolean {
  return (
    !member.providerApiKeyId ||
    !member.modelId.trim() ||
    !isValidWeight(member.weight) ||
    repeatsOrder !== null
  );
}

function idsOf(bucket: OrderBucket): string[] {
  return bucket.members.map((member) => member.id);
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
  fields,
  canDrag,
  canAdd,
  canFold,
  folded,
  onFold,
  highlighted,
  onAdd,
  onRemove,
}: {
  bucket: OrderBucket;
  fields: MemberFields;
  canDrag: boolean;
  canAdd: boolean;
  canFold: boolean;
  folded: boolean;
  onFold: (folded: boolean) => void;
  highlighted: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const { order } = bucket;
  const { setNodeRef } = useDroppable({ id: `zone:order:${order}` });

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
      <header
        className={cn(
          "flex items-center gap-2 px-3 py-2",
          !folded && "border-b",
        )}
      >
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
        {canFold ? (
          <UnstyledButton
            aria-expanded={!folded}
            aria-label={`${folded ? "Expand" : "Collapse"} order ${order}`}
            onClick={() => onFold(!folded)}
            className="-my-1 flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md py-1 pl-1 text-left"
          >
            {folded ? (
              <FoldedSummary bucket={bucket} options={fields.options} />
            ) : (
              <span className="flex-1" />
            )}
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                folded && "-rotate-90",
              )}
              aria-hidden="true"
            />
          </UnstyledButton>
        ) : null}
      </header>
      {folded ? null : (
        <OrderBody
          bucket={bucket}
          fields={fields}
          canDrag={canDrag}
          canAdd={canAdd}
          onAdd={onAdd}
          onRemove={onRemove}
        />
      )}
    </section>
  );
}

/** A folded order's header: who is in it, how traffic splits, how many are off. */
function FoldedSummary({
  bucket,
  options,
}: {
  bucket: OrderBucket;
  options: PoolOptions;
}) {
  const { members } = bucket;
  const names = [
    ...new Set(
      members.map(
        ({ member }) =>
          options.keysById.get(member.providerApiKeyId)?.name ?? "Provider key",
      ),
    ),
  ];
  const off = members.filter(({ member }) => !member.enabled).length;
  const shares = members.flatMap(({ share }) =>
    share === null ? [] : [share],
  );
  const only = members.length === 1 ? members[0] : null;

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
      <OverlappedIcons
        maxVisible={4}
        icons={members.flatMap(({ id, member }) => {
          const key = options.keysById.get(member.providerApiKeyId);
          return key
            ? [
                {
                  key: id,
                  icon: <ProviderIcon provider={key.provider} size={12} />,
                  tooltip: `${key.name} · ${member.modelId}`,
                },
              ]
            : [];
        })}
      />
      <span className="min-w-0 truncate text-foreground">
        {names.join(", ")}
      </span>
      {only ? (
        <span className="min-w-0 max-w-48 shrink-0 truncate font-mono">
          {only.member.modelId}
        </span>
      ) : null}
      {members.length > 3 ? (
        <Dot>{members.length} members</Dot>
      ) : shares.length > 1 ? (
        <Dot>{shares.join(" / ")}</Dot>
      ) : null}
      {off > 0 ? <Dot>{off} off</Dot> : null}
      <FoldedCooldown
        saved={members.flatMap(({ saved }) => (saved ? [saved] : []))}
      />
    </span>
  );
}

function Dot({ children }: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
      <span aria-hidden="true">·</span>
      <span>{children}</span>
    </span>
  );
}

/** An open order: column labels, member rows and "Add member". */
function OrderBody({
  bucket,
  fields,
  canDrag,
  canAdd,
  onAdd,
  onRemove,
}: {
  bucket: OrderBucket;
  fields: MemberFields;
  canDrag: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const { order, members } = bucket;
  const shared = members.length > 1;
  return (
    <>
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
              fields={fields}
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
          disabled={fields.disabled || !canAdd}
          onClick={onAdd}
          className="text-muted-foreground"
        >
          <Plus />
          <span>Add member</span>
        </Button>
      </div>
    </>
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
