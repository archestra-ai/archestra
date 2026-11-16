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
  Code,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
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
import { SettingsSaveBar } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { runtimeTemplatePosition } from "@/lib/agent-runtime-template-order";
import {
  useRuntimeTemplateCatalog,
  useRuntimeTemplateSettings,
  useSaveRuntimeTemplateSettings,
} from "@/lib/agent-runtime-templates.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
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
  const builtIns = getAgentCatalogTemplates(images, appName);
  const [draft, setDraft] = useState<SaveBody | null>(null);
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
  const state = draft ?? saved;
  const editable =
    canUpdate === true &&
    !disabled &&
    !!settings.data &&
    !!organization &&
    !save.isPending;
  const hasChanges =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const rows: Row[] = [
    ...AGENT_CATALOG_IDS.map((id) => ({
      id,
      name: AGENT_CATALOG_NAMES[id],
      description:
        builtIns.find((item) => item.id === id)?.summary ??
        "Maintained runtime",
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

  function position(id: string) {
    return runtimeTemplatePosition(
      id,
      settings.data ? state.templates : (summaries.data ?? []),
      state.popularAgentOverrides,
    );
  }
  function reorder(ids: string[]) {
    if (!editable) return;
    setDraft(
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
    if (!editable) return;
    setDraft({
      ...state,
      popularAgentOverrides: {
        ...state.popularAgentOverrides,
        [CUSTOM_IMAGE_RUNTIME_ID]: { hidden: !visible },
      },
    });
  }
  function setAvailable(row: Row, visible: boolean) {
    if (!editable) return;
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
    setDraft(
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Available runtimes</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The runtimes people can pick when creating an agent. Who can use
            each one, and change its settings on their agents, is set in its
            permissions.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
              {(removedRows.length > 0 || customImageHidden) && (
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
                  {customImageHidden && (
                    <DropdownMenuItem
                      onSelect={() => setCustomImageAvailable(true)}
                    >
                      <Code className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {CUSTOM_IMAGE_NAME}
                      </span>
                      <Plus className="ml-auto size-3.5" />
                    </DropdownMenuItem>
                  )}
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
                    onEdit={() =>
                      row.builtIn
                        ? setEditingBuiltIn(row.id as AgentCatalogId)
                        : setEditing(
                            state.templates.find(
                              (item) => item.id === row.id,
                            ) ?? null,
                          )
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {!customImageHidden && (
            <CustomImageRow
              disabled={!editable}
              bordered={visibleRows.length > 0}
              onRemove={() => setCustomImageAvailable(false)}
            />
          )}
          {!visibleRows.length && customImageHidden && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No runtimes offered. Add a runtime to get started.
            </p>
          )}
        </div>
      )}
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={save.isPending}
        disabledSave={!editable}
        permissions={{ organizationSettings: ["update"] }}
        onSave={() => save.mutate(state, { onSuccess: () => setDraft(null) })}
        onCancel={() => setDraft(null)}
      />
      {editingBuiltIn !== null && (
        <BuiltInRuntimeDialog
          id={editingBuiltIn}
          scope={agentRuntimePermissionScope({
            kind: "built-in",
            id: editingBuiltIn,
          })}
          hasUnsavedChanges={hasChanges}
          image={images[editingBuiltIn]}
          value={state.builtIns?.[editingBuiltIn]}
          onClose={() => setEditingBuiltIn(null)}
          onSave={(builtIn) => {
            setDraft({
              ...state,
              builtIns: { ...state.builtIns, [editingBuiltIn]: builtIn },
            });
            setEditingBuiltIn(null);
          }}
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
          hasUnsavedChanges={hasChanges}
          names={rows
            .filter((row) => row.id !== (editing === "new" ? null : editing.id))
            .map((row) => row.name)}
          onClose={() => setEditing(null)}
          onSave={(template) => {
            const next = {
              ...state,
              templates:
                editing === "new"
                  ? [...state.templates, template]
                  : state.templates.map((item) =>
                      item.id === template.id ? template : item,
                    ),
            };
            setDraft(
              editing === "new"
                ? withRuntimeOrder(next, [
                    ...visibleRows.map((row) => row.id),
                    template.id,
                    ...removedRows.map((row) => row.id),
                  ])
                : next,
            );
            setEditing(null);
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

/**
 * The choice to run an image that is none of the runtimes above. It sits
 * last in the catalog and has no settings of its own, so it can only be
 * taken off the list.
 */
function CustomImageRow({
  disabled,
  bordered,
  onRemove,
}: {
  disabled: boolean;
  bordered: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 bg-card py-2.5 pl-1.5 pr-2",
        bordered && "border-t",
      )}
    >
      <span className="size-5 shrink-0" />
      <span className="flex size-7 shrink-0 items-center justify-center">
        <Code className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium">
          {CUSTOM_IMAGE_NAME}
        </span>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          Lets people who can configure any runtime run their own container
          image and command.
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            disabled={disabled}
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-label={`Actions for ${CUSTOM_IMAGE_NAME}`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRemove}>
            <X className="size-3.5" />
            Remove from list
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const CUSTOM_IMAGE_NAME = "Custom image";

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
