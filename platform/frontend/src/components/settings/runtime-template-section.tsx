"use client";

import {
  AGENT_CATALOG_IDS,
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  type archestraApiTypes,
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
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { AgentIcon } from "@/components/agent-icon";
import {
  CatalogAgentIcon,
  getAgentCatalogTemplates,
  useAgentCatalogImages,
} from "@/components/agent-pages/agent-catalog";
import {
  AgentRuntimeEnvironmentFields,
  AgentRuntimeImageFields,
  AgentRuntimeProtocolField,
  AgentRuntimeSteeringField,
  defaultAgentRuntime,
} from "@/components/agent-runtime-fields";
import { IdentityFields } from "@/components/identity-fields";
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsSaveBar } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { runtimeTemplatePosition } from "@/lib/agent-runtime-template-order";
import {
  type RuntimeTemplate,
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
  const [editing, setEditing] = useState<RuntimeTemplate | "new" | null>(null);
  const saved: SaveBody = {
    revision: settings.data?.revision ?? 0,
    templates: settings.data?.templates ?? [],
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
          <h3 className="text-sm font-medium">Agent Runtimes</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            These runtimes appear as configuration templates when creating an
            agent. Drag to change their order, add custom runtimes, or remove
            built-in and custom choices. Removed runtimes can be added back at
            any time. Changes here don’t affect existing agents.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={!editable}>
              <Plus />
              <span>Add runtime</span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Not in this list</DropdownMenuLabel>
            {removedRows.length ? (
              removedRows.map((row) => (
                <DropdownMenuItem
                  key={row.id}
                  onSelect={() => setAvailable(row, true)}
                >
                  <RuntimeMark row={row} />
                  <span className="min-w-0 flex-1 truncate" title={row.name}>
                    {row.name}
                  </span>
                  <Plus className="ml-auto size-3.5" />
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>
                All saved runtimes are included
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
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
              <ul className="divide-y" aria-label="Agent Runtimes">
                {visibleRows.map((row, index) => (
                  <RuntimeTemplateRow
                    key={row.id}
                    row={row}
                    disabled={!editable}
                    onMove={(direction) => move(index, index + direction)}
                    onRemove={() => setAvailable(row, false)}
                    onEdit={() =>
                      setEditing(
                        state.templates.find((item) => item.id === row.id) ??
                          null,
                      )
                    }
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
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={save.isPending}
        disabledSave={!editable}
        permissions={{ organizationSettings: ["update"] }}
        onSave={() => save.mutate(state, { onSuccess: () => setDraft(null) })}
        onCancel={() => setDraft(null)}
      />
      {editing !== null && (
        <RuntimeTemplateDialog
          key={editing === "new" ? "new" : editing.id}
          template={editing === "new" ? null : editing}
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
  const TypeIcon = row.builtIn ? LockKeyhole : Box;
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
          <span
            className="inline-flex shrink-0 text-muted-foreground/70"
            title={row.builtIn ? "Built-in runtime" : "Custom runtime"}
          >
            <TypeIcon className="size-3" />
            <span className="sr-only">
              {row.builtIn ? "Built-in runtime" : "Custom runtime"}
            </span>
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="max-w-full truncate" title={row.description}>
            {row.description}
          </span>
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
          {!row.builtIn && (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="size-3.5" />
              Edit runtime
            </DropdownMenuItem>
          )}
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

function RuntimeTemplateDialog({
  template,
  names,
  onClose,
  onSave,
}: {
  template: RuntimeTemplate | null;
  names: string[];
  onClose: () => void;
  onSave: (template: RuntimeTemplate) => void;
}) {
  const form = useForm<RuntimeTemplate>({
    defaultValues: template ?? {
      id: crypto.randomUUID(),
      name: "",
      description: "",
      icon: null,
      hidden: false,
      position: 0,
      runtime: { ...defaultAgentRuntime(), privileged: false },
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <Form {...form}>
          <form className="contents" onSubmit={form.handleSubmit(onSave)}>
            <DialogHeader>
              <DialogTitle>
                {template ? "Edit custom runtime" : "Add custom runtime"}
              </DialogTitle>
              <DialogDescription>
                A reusable starting configuration for new agents. You can still
                adjust each agent after selecting it.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-5">
              <Controller
                control={form.control}
                name="icon"
                render={({ field: iconField }) => (
                  <FormField
                    control={form.control}
                    name="name"
                    rules={{
                      required: "Enter a name",
                      maxLength: {
                        value: 100,
                        message: "Use at most 100 characters",
                      },
                      validate: (value) =>
                        !value.trim()
                          ? "Enter a name"
                          : names.some(
                                (name) =>
                                  name.toLocaleLowerCase() ===
                                  value.trim().toLocaleLowerCase(),
                              )
                            ? "Choose a unique runtime name"
                            : true,
                    }}
                    render={({ field }) => (
                      <FormItem>
                        <IdentityFields
                          icon={iconField.value}
                          onIconChange={iconField.onChange}
                          label={<FormLabel>Name</FormLabel>}
                        >
                          <FormControl>
                            <Input
                              {...field}
                              maxLength={100}
                              placeholder="Engineering workspace"
                            />
                          </FormControl>
                          <FormMessage />
                        </IdentityFields>
                      </FormItem>
                    )}
                  />
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        maxLength={1_000}
                        placeholder="What should people use this runtime for?"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="runtime"
                rules={{
                  validate: (runtime) =>
                    !runtime.image.trim()
                      ? "Enter a Docker image"
                      : /\s/.test(runtime.image.trim())
                        ? "Docker images cannot contain whitespace"
                        : true,
                }}
                render={({ field }) => (
                  <FormItem>
                    <div className="space-y-5">
                      <AgentRuntimeImageFields
                        value={field.value}
                        onChange={(value) =>
                          field.onChange({ ...value, privileged: false })
                        }
                      />
                      <FormMessage />
                      <AgentRuntimeProtocolField
                        value={field.value}
                        onChange={field.onChange}
                      />
                      <AgentRuntimeSteeringField
                        value={field.value}
                        onChange={field.onChange}
                      />
                      <AgentRuntimeEnvironmentFields
                        value={field.value}
                        onChange={field.onChange}
                      />
                    </div>
                  </FormItem>
                )}
              />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">
                {template ? "Update template" : "Add template"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
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
