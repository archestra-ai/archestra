"use client";

import {
  AGENT_CATALOG_IDS,
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  agentRuntimePermissionScope,
  type archestraApiTypes,
  CUSTOM_IMAGE_RUNTIME_ID,
  isIntegrationHidden,
} from "@archestra/shared";
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Box,
  ChevronDown,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  CatalogAgentIcon,
  getAgentCatalogTemplates,
  useAgentCatalogImages,
} from "@/components/agent-pages/agent-catalog";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceListActions } from "@/components/resource-list-actions";
import {
  BuiltInRuntimeDialog,
  CustomRuntimeDialog,
  RuntimeKindLabel,
  type TemplateDraft,
} from "@/components/settings/runtime-template-dialogs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { RUNTIME_EDIT_PARAM } from "@/lib/agent-runtime-settings-link";
import { runtimeTemplatePosition } from "@/lib/agent-runtime-template-order";
import {
  useRuntimeTemplateCatalog,
  useRuntimeTemplateSettings,
  useSaveRuntimeTemplateSettings,
} from "@/lib/agent-runtime-templates.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";

type SaveBody = archestraApiTypes.SaveRuntimeTemplateSettingsData["body"];
type Row = {
  id: string;
  name: string;
  description: string;
  image: string;
  icon: string | null;
  hidden: boolean;
  builtIn: boolean;
};

export function RuntimeTemplateSection({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const { data: canUpdate } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const {
    data: organization,
    isError: organizationError,
    refetch: reloadOrganization,
  } = useOrganization(true, { fresh: true });
  const summaries = useRuntimeTemplateCatalog();
  const settings = useRuntimeTemplateSettings(canUpdate === true);
  const save = useSaveRuntimeTemplateSettings();
  const images = useAgentCatalogImages();
  const appName = useAppName();
  const customImagesId = useId();
  const builtIns = getAgentCatalogTemplates(images, appName);
  // The change being saved, shown at once and dropped when the save
  // settles: a success replaces it with the saved settings, a failure puts
  // the list back as it was.
  const [pending, setPending] = useState<SaveBody | null>(null);
  const [editing, setEditing] = useState<TemplateDraft | "new" | null>(null);
  const [editingBuiltIn, setEditingBuiltIn] = useState<AgentCatalogId | null>(
    null,
  );
  const saved: SaveBody = {
    revision: settings.data?.revision ?? 0,
    templates: settings.data?.templates ?? [],
    builtIns: settings.data?.builtIns ?? {},
    popularAgentOverrides: settings.data
      ? settings.data.popularAgentOverrides
      : (organization?.popularAgentOverrides ?? null),
  };
  const state = pending ?? saved;
  const editable =
    canUpdate === true &&
    !disabled &&
    !!settings.data &&
    !!organization &&
    !save.isPending;
  const rows: Row[] = [
    ...AGENT_CATALOG_IDS.map((id) => ({
      id,
      name: AGENT_CATALOG_NAMES[id],
      description:
        builtIns.find((item) => item.id === id)?.summary ?? "Built-in runtime",
      image: images[id],
      icon: null,
      hidden: state.popularAgentOverrides?.[id]?.hidden ?? false,
      builtIn: true,
    })),
    ...(settings.data
      ? state.templates.map((item) => ({
          ...item,
          image: item.runtime.image,
          builtIn: false,
        }))
      : (summaries.data ?? []).map((item) => ({ ...item, builtIn: false }))),
  ].sort((a, b) => position(a.id) - position(b.id));
  const visibleRows = rows.filter((row) => !row.hidden);
  const removedRows = rows.filter((row) => row.hidden);
  // A link can name the runtime whose editor opens on load, as the badge
  // beside an agent's name does: a maintained runtime's id or a custom
  // runtime's. It opens once the list can be edited, and closing the editor
  // takes the name out of the URL.
  const linkedId = useSearchParams().get(RUNTIME_EDIT_PARAM);
  const linkedRow =
    editable && linkedId ? rows.find((row) => row.id === linkedId) : undefined;
  const linkedRowId = linkedRow?.id;
  const linked = useDialogUrlParam<{ id: string }>({
    paramName: RUNTIME_EDIT_PARAM,
    entityFromUrl: useMemo(
      () => (linkedRowId ? { id: linkedRowId } : null),
      [linkedRowId],
    ),
  });
  const openedByLink = linked.entity?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: opened once per link, with the list as it is then
  useEffect(() => {
    if (openedByLink) editRuntime(openedByLink);
  }, [openedByLink]);
  const closeLinked = linked.close;
  const customImageHidden = isIntegrationHidden(
    state.popularAgentOverrides,
    CUSTOM_IMAGE_RUNTIME_ID,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  /** Every change to the list saves at once; there is no draft to keep. */
  function commit(next: SaveBody, onSaved?: () => void) {
    if (!editable) return;
    setPending(next);
    save.mutate(next, {
      onSuccess: onSaved,
      onSettled: () => setPending(null),
    });
  }
  function editRuntime(id: string) {
    if (AGENT_CATALOG_IDS.includes(id as AgentCatalogId)) {
      setEditingBuiltIn(id as AgentCatalogId);
      return;
    }
    setEditing(state.templates.find((item) => item.id === id) ?? null);
  }
  /** Closes the open editor, and forgets the link that opened it. */
  function closeEditor() {
    setEditing(null);
    setEditingBuiltIn(null);
    if (openedByLink) closeLinked();
  }
  function position(id: string) {
    return runtimeTemplatePosition(
      id,
      settings.data ? state.templates : (summaries.data ?? []),
      state.popularAgentOverrides,
    );
  }
  function reorder(ids: string[]) {
    commit(
      withRuntimeOrder(state, [...ids, ...removedRows.map((row) => row.id)]),
    );
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= visibleRows.length || from < 0) return;
    reorder(
      arrayMove(
        visibleRows.map((item) => item.id),
        from,
        to,
      ),
    );
  }
  function onDragEnd({ active, over }: DragEndEvent) {
    if (over && active.id !== over.id)
      move(
        visibleRows.findIndex((item) => item.id === active.id),
        visibleRows.findIndex((item) => item.id === over.id),
      );
  }
  function setCustomImageAvailable(visible: boolean) {
    commit({
      ...state,
      popularAgentOverrides: {
        ...state.popularAgentOverrides,
        [CUSTOM_IMAGE_RUNTIME_ID]: { hidden: !visible },
      },
    });
  }
  function setAvailable(row: Row, visible: boolean) {
    const next = row.builtIn
      ? {
          ...state,
          popularAgentOverrides: {
            ...state.popularAgentOverrides,
            [row.id]: {
              ...state.popularAgentOverrides?.[row.id as AgentCatalogId],
              hidden: !visible,
            },
          },
        }
      : {
          ...state,
          templates: state.templates.map((item) =>
            item.id === row.id ? { ...item, hidden: !visible } : item,
          ),
        };
    commit(
      visible
        ? withRuntimeOrder(next, [
            ...visibleRows.map((item) => item.id),
            row.id,
            ...removedRows
              .filter((item) => item.id !== row.id)
              .map((item) => item.id),
          ])
        : next,
    );
  }

  return (
    <section id="popular-agents" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">Available runtimes</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The runtimes people can pick when creating an agent. Who can use
            each one, and change its settings on their agents, is set in its
            permissions.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ResourceListActions resource="agentRuntime" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={!editable}>
                <Plus />
                <span>Add runtime</span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {removedRows.length > 0 && (
                <>
                  <DropdownMenuLabel>Removed runtimes</DropdownMenuLabel>
                  {removedRows.map((row) => (
                    <DropdownMenuItem
                      key={row.id}
                      onSelect={() => setAvailable(row, true)}
                    >
                      <RuntimeMark row={row} />
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={row.name}
                      >
                        {row.name}
                      </span>
                      <Plus className="ml-auto size-3.5" />
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                disabled={state.templates.length >= 100}
                onSelect={() => setEditing("new")}
              >
                <Plus />
                <span>Create custom runtime…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {organizationError || settings.isError ? (
        <QueryLoadError
          title="Could not load runtime templates"
          onRetry={() => {
            void settings.refetch();
            void reloadOrganization();
          }}
        />
      ) : canUpdate && !settings.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={visibleRows.map((row) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y" aria-label="Available runtimes">
                {visibleRows.map((row, index) => (
                  <RuntimeTemplateRow
                    key={row.id}
                    row={row}
                    disabled={!editable}
                    onMove={(direction) => move(index, index + direction)}
                    onRemove={() => setAvailable(row, false)}
                    onEdit={() => editRuntime(row.id)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {!visibleRows.length && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No runtimes offered. Add a runtime to get started.
            </p>
          )}
        </div>
      )}
      {/* Not a runtime: the choice to run an image that is none of them. */}
      <div className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={customImagesId}>Allow custom images</Label>
          <p className="text-xs text-muted-foreground">
            Offers a Custom image choice when creating an agent, for people who
            can configure any runtime to run their own container image and
            command. Turning it off keeps existing agents as they are.
          </p>
        </div>
        <Switch
          id={customImagesId}
          checked={!customImageHidden}
          disabled={!editable}
          onCheckedChange={setCustomImageAvailable}
        />
      </div>
      {editingBuiltIn !== null && (
        <BuiltInRuntimeDialog
          id={editingBuiltIn}
          scope={agentRuntimePermissionScope({
            kind: "built-in",
            id: editingBuiltIn,
          })}
          isSaving={save.isPending}
          image={images[editingBuiltIn]}
          value={state.builtIns?.[editingBuiltIn]}
          onClose={closeEditor}
          onSave={(builtIn, onSaved) =>
            commit(
              {
                ...state,
                builtIns: { ...state.builtIns, [editingBuiltIn]: builtIn },
              },
              onSaved,
            )
          }
        />
      )}
      {editing !== null && (
        <CustomRuntimeDialog
          key={editing === "new" ? "new" : editing.id}
          template={editing === "new" ? null : editing}
          savedScope={
            editing !== "new" &&
            settings.data?.templates.some((item) => item.id === editing.id)
              ? editing.id
              : null
          }
          isSaving={save.isPending}
          names={rows
            .filter((row) => row.id !== (editing === "new" ? null : editing.id))
            .map((row) => row.name)}
          onClose={closeEditor}
          onSave={(template, onSaved) => {
            const next = {
              ...state,
              templates:
                editing === "new"
                  ? [...state.templates, template]
                  : state.templates.map((item) =>
                      item.id === template.id ? template : item,
                    ),
            };
            commit(
              editing === "new"
                ? withRuntimeOrder(next, [
                    ...visibleRows.map((row) => row.id),
                    template.id,
                    ...removedRows.map((row) => row.id),
                  ])
                : next,
              () => {
                // A runtime just added has no agents to update.
                if (editing === "new") {
                  setEditing(null);
                  return;
                }
                setEditing(template);
                onSaved();
              },
            );
          }}
        />
      )}
    </section>
  );
}

function RuntimeTemplateRow({
  row,
  disabled,
  onMove,
  onRemove,
  onEdit,
}: {
  row: Row;
  disabled: boolean;
  onMove: (direction: number) => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group flex items-center gap-2 bg-card py-2.5 pl-1.5 pr-2",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <UnstyledButton
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={`Reorder ${row.name}`}
        className="flex size-5 shrink-0 touch-none cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-not-allowed"
        onKeyDown={(event) => {
          if (!isDragging && ["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          } else listeners?.onKeyDown?.(event);
        }}
      >
        <GripVertical className="size-3.5" />
      </UnstyledButton>
      <span className="flex size-7 shrink-0 items-center justify-center">
        <RuntimeMark row={row} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={row.name}>
            {row.name}
          </span>
          <RuntimeKindLabel builtIn={row.builtIn} />
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {row.description && (
            <span className="max-w-full truncate" title={row.description}>
              {row.description}
            </span>
          )}
          <span
            className="max-w-full truncate font-mono text-[11px] opacity-70"
            title={row.image}
          >
            {row.image}
          </span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            disabled={disabled}
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-label={`Actions for ${row.name}`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-3.5" />
            Edit runtime
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRemove}>
            <X className="size-3.5" />
            Remove from list
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function RuntimeMark({ row }: { row: Row }) {
  if (row.builtIn)
    return <CatalogAgentIcon id={row.id as AgentCatalogId} size={19} />;
  return row.icon ? (
    <AgentIcon icon={row.icon} size={19} />
  ) : (
    <Box className="size-4 text-muted-foreground" />
  );
}

function withRuntimeOrder(state: SaveBody, ids: string[]): SaveBody {
  const overrides = { ...state.popularAgentOverrides };
  ids.forEach((id, position) => {
    if (AGENT_CATALOG_IDS.includes(id as AgentCatalogId))
      overrides[id as AgentCatalogId] = {
        ...overrides[id as AgentCatalogId],
        position,
      };
  });
  return {
    ...state,
    popularAgentOverrides: overrides,
    templates: state.templates.map((item) => ({
      ...item,
      position: ids.indexOf(item.id),
    })),
  };
}
