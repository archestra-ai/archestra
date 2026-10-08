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
import { GripVertical, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { ClientIcon } from "@/app/connection/client-icon";
import type { ConnectClient } from "@/app/connection/clients";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

export function AvailableAgentsList({
  clients,
  shownClientIds,
  onShownClientIdsChange,
  onOrderChange,
  disabled,
}: {
  clients: ConnectClient[];
  shownClientIds: string[];
  onShownClientIdsChange: (ids: string[]) => void;
  onOrderChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  const addAgentId = useId();
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
  const selectedClients = clients.filter((client) =>
    shownClientIds.includes(client.id),
  );
  const remainingClients = clients.filter(
    (client) => !shownClientIds.includes(client.id),
  );
  const ids = selectedClients.map((client) => client.id);
  const remainingIds = remainingClients.map((client) => client.id);
  const canAdd = remainingClients.length > 0;
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
      <SearchableSelect
        id={addAgentId}
        value=""
        ariaLabel={addLabel}
        placeholder={addLabel}
        searchPlaceholder="Search agents…"
        emptyMessage="No agents match."
        className="w-64 max-w-full"
        disabled={disabled || !canAdd}
        items={[...remainingClients]
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((client) => ({
            value: client.id,
            label: client.label,
            content: (
              <span className="flex items-center gap-2">
                <ClientIcon client={client} size={20} />
                <span>{client.label}</span>
              </span>
            ),
          }))}
        onValueChange={(id) => {
          if (disabled || !remainingIds.includes(id)) return;
          if (remainingIds.length === 1) focusAfterChange.current = id;
          onShownClientIdsChange([...shownClientIds, id]);
          onOrderChange([...ids, id]);
        }}
      />
      {selectedClients.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents added. Generic client is still available.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <ul
              aria-label="Available agents"
              className="flex flex-wrap gap-1.5 rounded-md border border-input bg-background p-2"
            >
              {selectedClients.map((client, index) => (
                <AvailableAgentPill
                  key={client.id}
                  client={client}
                  disabled={disabled}
                  removeButtonRef={(node) => {
                    if (node) removeButtons.current.set(client.id, node);
                    else removeButtons.current.delete(client.id);
                  }}
                  onRemove={() => {
                    focusAfterChange.current =
                      ids[index + 1] ?? ids[index - 1] ?? addAgentId;
                    onShownClientIdsChange(
                      shownClientIds.filter((id) => id !== client.id),
                    );
                  }}
                  onMove={(direction) => move(index, index + direction)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function AvailableAgentPill({
  client,
  disabled,
  onRemove,
  onMove,
  removeButtonRef,
}: {
  client: ConnectClient;
  disabled: boolean;
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
  } = useSortable({ id: client.id, disabled });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted px-2 py-0.5 text-sm",
        disabled && "opacity-50",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <UnstyledButton
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${client.label}`}
        disabled={disabled}
        className="flex min-w-0 items-center gap-1.5 rounded-sm py-1 touch-none cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-not-allowed"
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
        <ClientIcon client={client} size={18} />
        <span className="truncate">{client.label}</span>
      </UnstyledButton>
      <UnstyledButton
        ref={removeButtonRef}
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${client.label} from Connect`}
        className="shrink-0 rounded-sm p-1.5 text-muted-foreground hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
      >
        <X className="size-3" />
      </UnstyledButton>
    </li>
  );
}
