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
  GripVertical,
  LockKeyhole,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { AgentIcon } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
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
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsSaveBar } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { UnstyledButton } from "@/components/ui/unstyled-button";
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
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<SaveBody | null>(null);
  const [editing, setEditing] = useState<RuntimeTemplate | "new" | null>(null);
  const [deleting, setDeleting] = useState<RuntimeTemplate | null>(null);
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function position(id: string) {
    const custom = (
      settings.data ? state.templates : (summaries.data ?? [])
    ).find((item) => item.id === id);
    if (custom) return custom.position;
    return (
      state.popularAgentOverrides?.[id as AgentCatalogId]?.position ??
      AGENT_CATALOG_IDS.indexOf(id as AgentCatalogId)
    );
  }
  function reorder(ids: string[]) {
    if (!editable) return;
    const overrides = { ...state.popularAgentOverrides };
    ids.forEach((id, position) => {
      if (AGENT_CATALOG_IDS.includes(id as AgentCatalogId))
        overrides[id as AgentCatalogId] = {
          ...overrides[id as AgentCatalogId],
          position,
        };
    });
    setDraft({
      ...state,
      templates: state.templates.map((item) => ({
        ...item,
        position: ids.indexOf(item.id),
      })),
      popularAgentOverrides: overrides,
    });
  }
  function move(from: number, to: number) {
    if (to < 0 || to >= rows.length || from < 0) return;
    reorder(
      arrayMove(
        rows.map((item) => item.id),
        from,
        to,
      ),
    );
  }
  function onDragEnd({ active, over }: DragEndEvent) {
    if (over && active.id !== over.id)
      move(
        rows.findIndex((item) => item.id === active.id),
        rows.findIndex((item) => item.id === over.id),
      );
  }
  function toggle(row: Row, visible: boolean) {
    if (!editable) return;
    setDraft(
      row.builtIn
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
          },
    );
  }

  return (
    <section id="popular-agents" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Agent Runtimes</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Choose the runtimes offered when creating an agent. Drag to set
            their order, or add a template for your own container.
          </p>
        </div>
        <Button
          ref={addButtonRef}
          size="sm"
          variant="outline"
          disabled={!editable || state.templates.length >= 100}
          onClick={() => setEditing("new")}
        >
          <Plus />
          <span>Add custom runtime</span>
        </Button>
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
              items={rows.map((row) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y" aria-label="Agent Runtimes">
                {rows.map((row, index) => (
                  <RuntimeTemplateRow
                    key={row.id}
                    row={row}
                    disabled={!editable}
                    onMove={(direction) => move(index, index + direction)}
                    onToggle={(visible) => toggle(row, visible)}
                    onEdit={() =>
                      setEditing(
                        state.templates.find((item) => item.id === row.id) ??
                          null,
                      )
                    }
                    onDelete={() =>
                      setDeleting(
                        state.templates.find((item) => item.id === row.id) ??
                          null,
                      )
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {rows.filter((item) => !item.hidden).length} runtimes available when
            creating an agent
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Built-in templates are maintained automatically. Template changes apply
        to new agents; existing agents keep their saved configuration.
      </p>
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
            setDraft({
              ...state,
              templates:
                editing === "new"
                  ? [...state.templates, { ...template, position: rows.length }]
                  : state.templates.map((item) =>
                      item.id === template.id ? template : item,
                    ),
            });
            setEditing(null);
          }}
        />
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            addButtonRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete runtime template?</DialogTitle>
            <DialogDescription>
              Remove {deleting?.name} from the runtime choices. Existing agents
              keep their configuration. This change takes effect when you save
              settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!editable) return;
                setDraft({
                  ...state,
                  templates: state.templates.filter(
                    (item) => item.id !== deleting?.id,
                  ),
                });
                setDeleting(null);
              }}
            >
              Delete template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function RuntimeTemplateRow({
  row,
  disabled,
  onMove,
  onToggle,
  onEdit,
  onDelete,
}: {
  row: Row;
  disabled: boolean;
  onMove: (direction: number) => void;
  onToggle: (visible: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
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
        "flex items-center gap-3 bg-card px-4 py-3",
        row.hidden && "opacity-60",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <UnstyledButton
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={`Reorder ${row.name}`}
        className="touch-none shrink-0 cursor-grab rounded-sm p-1 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        onKeyDown={(event) => {
          if (!isDragging && ["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          } else listeners?.onKeyDown?.(event);
        }}
      >
        <GripVertical className="size-4 text-muted-foreground" />
      </UnstyledButton>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
        {row.builtIn ? (
          <CatalogAgentIcon id={row.id as AgentCatalogId} />
        ) : row.icon ? (
          <AgentIcon icon={row.icon} size={22} />
        ) : (
          <Box className="size-5 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium">{row.name}</span>
          <Badge variant="outline">
            {row.builtIn && <LockKeyhole className="size-3" />}
            <span>{row.builtIn ? "Built-in" : "Custom"}</span>
          </Badge>
        </div>
        <p className="break-words text-sm text-muted-foreground">
          {row.description}
        </p>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {row.image}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {!row.builtIn && (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`Edit ${row.name}`}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`Delete ${row.name}`}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </>
        )}
        <Switch
          disabled={disabled}
          checked={!row.hidden}
          onCheckedChange={onToggle}
          aria-label={`Offer ${row.name} when creating agents`}
        />
      </div>
    </li>
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
              <div className="flex items-start gap-4">
                <Controller
                  control={form.control}
                  name="icon"
                  render={({ field }) => (
                    <div className="space-y-1">
                      <AgentIconPicker
                        value={field.value}
                        onChange={field.onChange}
                      />
                      <p className="text-xs text-muted-foreground">
                        Display icon
                      </p>
                    </div>
                  )}
                />
                <div className="min-w-0 flex-1">
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
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            maxLength={100}
                            placeholder="Engineering workspace"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
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
              <p className="text-xs text-muted-foreground">
                The display icon appears on the choice card. The Docker image
                below is the container that runs the agent.
              </p>
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
