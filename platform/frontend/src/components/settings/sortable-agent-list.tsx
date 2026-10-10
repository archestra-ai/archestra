"use client";

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
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

export function SortableAgentList({
  items,
  shownItemIds,
  onShownItemIdsChange,
  onOrderChange,
  disabled,
  label,
  emptyMessage,
  removeLabelSuffix = "",
  inlineAdd = false,
  inlineAddLabel = "Add agent",
}: {
  items: { id: string; label: string; icon: ReactNode }[];
  shownItemIds: string[];
  onShownItemIdsChange: (ids: string[]) => void;
  onOrderChange: (ids: string[]) => void;
  disabled: boolean;
  label: string;
  emptyMessage: string;
  removeLabelSuffix?: string;
  inlineAdd?: boolean;
  inlineAddLabel?: string;
}) {
  const addAgentId = useId();
  const [addOpen, setAddOpen] = useState(false);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterChange = useRef<string | null>(null);
  useEffect(() => {
    const target = focusAfterChange.current;
    if (target === null) return;
    (
      removeButtons.current.get(target) ?? document.getElementById(addAgentId)
    )?.focus();
    focusAfterChange.current = null;
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const selectedItems = items.filter((item) => shownItemIds.includes(item.id));
  const remainingItems = items.filter(
    (item) => !shownItemIds.includes(item.id),
  );
  const ids = selectedItems.map((item) => item.id);
  const remainingIds = remainingItems.map((item) => item.id);
  const canAdd = remainingItems.length > 0;
  const addLabel = canAdd ? "Add an agent" : "All agents added";
  const move = (from: number, to: number) => {
    if (disabled || from < 0 || to < 0 || to >= ids.length || from === to)
      return;
    onOrderChange(arrayMove(ids, from, to));
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  };

  return (
    <div className="space-y-3">
      {!inlineAdd && (
        <SearchableSelect
          id={addAgentId}
          value=""
          ariaLabel={addLabel}
          placeholder={addLabel}
          searchPlaceholder="Search agents…"
          emptyMessage="No agents match."
          className="w-64 max-w-full"
          disabled={disabled || !canAdd}
          items={[...remainingItems]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((item) => ({
              value: item.id,
              label: item.label,
              content: (
                <span className="flex items-center gap-2">
                  {item.icon}
                  <span>{item.label}</span>
                </span>
              ),
            }))}
          onValueChange={(id) => {
            if (disabled || !remainingIds.includes(id)) return;
            if (remainingIds.length === 1) focusAfterChange.current = id;
            onShownItemIdsChange([...shownItemIds, id]);
            onOrderChange([...ids, id]);
          }}
        />
      )}
      {!inlineAdd && selectedItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <ul
              aria-label={label}
              className={cn(
                "flex flex-wrap gap-1.5 rounded-md border border-input bg-background p-2",
                inlineAdd && "min-h-9 items-center px-3 py-1",
              )}
            >
              {inlineAdd && selectedItems.length === 0 && (
                <li className="flex items-center text-sm text-muted-foreground">
                  {emptyMessage}
                </li>
              )}
              {selectedItems.map((item, index) => (
                <AvailableAgentPill
                  key={item.id}
                  item={item}
                  disabled={disabled}
                  compact={inlineAdd}
                  removeLabelSuffix={removeLabelSuffix}
                  removeButtonRef={(node) => {
                    if (node) removeButtons.current.set(item.id, node);
                    else removeButtons.current.delete(item.id);
                  }}
                  onRemove={() => {
                    focusAfterChange.current =
                      ids[index + 1] ?? ids[index - 1] ?? addAgentId;
                    onShownItemIdsChange(
                      shownItemIds.filter((id) => id !== item.id),
                    );
                  }}
                  onMove={(direction) => move(index, index + direction)}
                />
              ))}
              {inlineAdd && (
                <li className="flex items-center">
                  <Popover
                    open={addOpen && !disabled && canAdd}
                    onOpenChange={setAddOpen}
                  >
                    <PopoverTrigger asChild>
                      <ButtonWithTooltip
                        id={addAgentId}
                        size="icon-xs"
                        variant="ghost"
                        aria-label={inlineAddLabel}
                        disabled={disabled || !canAdd}
                        disabledText={
                          canAdd
                            ? "Editing unavailable"
                            : "All agents are already added"
                        }
                        className="rounded-md border border-dashed border-input text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                      >
                        <Plus className="size-3" />
                      </ButtonWithTooltip>
                    </PopoverTrigger>
                    <PopoverContent className="w-56 p-1" align="start">
                      {remainingItems.map((item) => (
                        <Button
                          key={item.id}
                          aria-label={item.label}
                          size="sm"
                          variant="ghost"
                          className="w-full justify-start"
                          onClick={() => {
                            if (disabled) return;
                            if (remainingIds.length === 1)
                              focusAfterChange.current = item.id;
                            onShownItemIdsChange([...shownItemIds, item.id]);
                            onOrderChange([...ids, item.id]);
                            setAddOpen(false);
                          }}
                        >
                          {item.icon}
                          <span>{item.label}</span>
                        </Button>
                      ))}
                    </PopoverContent>
                  </Popover>
                </li>
              )}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function AvailableAgentPill({
  item,
  disabled,
  onRemove,
  onMove,
  removeButtonRef,
  removeLabelSuffix,
  compact,
}: {
  item: { id: string; label: string; icon: ReactNode };
  disabled: boolean;
  removeLabelSuffix: string;
  compact: boolean;
  onRemove: () => void;
  onMove: (direction: number) => void;
  removeButtonRef: (node: HTMLButtonElement | null) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted px-2 py-0.5 text-sm",
        compact && "h-7",
        disabled && "opacity-50",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <UnstyledButton
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${item.label}`}
        disabled={disabled}
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-sm touch-none cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-not-allowed",
          !compact && "py-1",
        )}
        onKeyDown={(event) => {
          if (
            !isDragging &&
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            onMove(
              event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1,
            );
          } else {
            listeners?.onKeyDown?.(event);
          }
        }}
      >
        <GripVertical className="size-3 shrink-0 text-muted-foreground" />
        {item.icon}
        <span className="truncate">{item.label}</span>
      </UnstyledButton>
      <UnstyledButton
        ref={removeButtonRef}
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${item.label}${removeLabelSuffix}`}
        className={cn(
          "shrink-0 rounded-sm text-muted-foreground hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
          !compact && "p-1.5",
        )}
      >
        <X className="size-3" />
      </UnstyledButton>
    </li>
  );
}
