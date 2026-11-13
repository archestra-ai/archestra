"use client";

import {
  AGENT_CATALOG_IDS,
  AGENT_CATALOG_NAMES,
  type AgentCatalogId,
  type archestraApiTypes,
  buildAgentCatalogRuntime,
  withAgentRuntimeDefaults,
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
  BadgeCheck,
  Box,
  ChevronDown,
  GripVertical,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { AgentIcon } from "@/components/agent-icon";
import {
  CatalogAgentIcon,
  getAgentCatalogTemplates,
  useAgentCatalogImages,
} from "@/components/agent-pages/agent-catalog";
import {
  AGENT_RUNTIME_PROTOCOL_LABELS,
  type AgentRuntimeConfig,
  AgentRuntimeEnvironmentFields,
  AgentRuntimeImageFields,
  AgentRuntimeLimitFields,
  AgentRuntimeProtocolField,
  AgentRuntimeSteeringField,
  defaultAgentRuntime,
} from "@/components/agent-runtime-fields";
import { ConfigurationRow } from "@/components/configuration-row";
import { IdentityFields } from "@/components/identity-fields";
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsSaveBar } from "@/components/settings/settings-block";
import { Accordion } from "@/components/ui/accordion";
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
import { FieldDescription } from "@/components/ui/field-description";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { runtimeTemplatePosition } from "@/lib/agent-runtime-template-order";
import {
  useRuntimeTemplateCatalog,
  useRuntimeTemplateSettings,
  useSaveRuntimeTemplateSettings,
} from "@/lib/agent-runtime-templates.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";

type SaveBody = archestraApiTypes.SaveRuntimeTemplateSettingsData["body"];
type TemplateDraft = SaveBody["templates"][number];
type BuiltInRuntime = NonNullable<
  NonNullable<SaveBody["builtIns"]>[AgentCatalogId]
>;
type Row = {
  id: string;
  name: string;
  description: string;
  image: string;
  icon: string | null;
  hidden: boolean;
  builtIn: boolean;
  locked: boolean;
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
      locked: state.builtIns?.[id]?.locked ?? false,
    })),
    ...(settings.data
      ? state.templates.map((item) => ({
          ...item,
          image: item.runtime.image,
          builtIn: false,
          locked: item.locked ?? false,
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
          <h3 className="text-sm font-medium">Available runtimes</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The runtimes people can pick when creating an agent. A locked
            runtime&apos;s settings apply to every agent that uses it and change
            only here, with <Permission>organizationSettings:update</Permission>
            .
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
            {removedRows.length > 0 && (
              <>
                <DropdownMenuLabel>Removed runtimes</DropdownMenuLabel>
                {removedRows.map((row) => (
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
      {editingBuiltIn !== null && (
        <BuiltInRuntimeDialog
          id={editingBuiltIn}
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
          {row.locked && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              <LockKeyhole className="size-3" />
              Locked
            </span>
          )}
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

function RuntimeTemplateDialog({
  template,
  names,
  onClose,
  onSave,
}: {
  template: TemplateDraft | null;
  names: string[];
  onClose: () => void;
  onSave: (template: TemplateDraft) => void;
}) {
  const id = useId();
  const form = useForm<TemplateDraft>({
    defaultValues: template ?? {
      id: crypto.randomUUID(),
      name: "",
      description: "",
      icon: null,
      hidden: false,
      position: 0,
      locked: false,
      runtime: { ...defaultAgentRuntime(), privileged: false },
    },
  });
  // A new runtime opens on its image, the one thing it can't do without; an
  // existing one opens collapsed so its summaries read as an overview.
  const [openRows, setOpenRows] = useState<string[]>(
    template ? [] : ["container"],
  );
  const runtime = useWatch({ control: form.control, name: "runtime" });
  const limits = useLimitsSummary(runtime);
  const runtimeError = form.formState.errors.runtime?.message;
  const imageAttention =
    typeof runtimeError === "string" ? runtimeError : undefined;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          // Start on the name rather than the first row, whose focus ring
          // would show before anything was done.
          event.preventDefault();
          form.setFocus("name");
        }}
      >
        <Form {...form}>
          <form
            className="contents"
            onSubmit={form.handleSubmit(onSave, (errors) => {
              if (errors.runtime)
                setOpenRows((rows) =>
                  rows.includes("container") ? rows : [...rows, "container"],
                );
            })}
          >
            <DialogHeader>
              <div className="flex items-center gap-2">
                <DialogTitle>
                  {template ? `Edit ${template.name}` : "Add custom runtime"}
                </DialogTitle>
                <RuntimeKindLabel builtIn={false} />
              </div>
              <DialogDescription>
                Defaults for new agents that use this runtime.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-6">
              <div className="space-y-4">
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
                          value={field.value ?? ""}
                          rows={2}
                          maxLength={1_000}
                          className="min-h-0 resize-none"
                          placeholder="What should people use this runtime for?"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="runtime"
                rules={{
                  validate: (value) =>
                    !value.image.trim()
                      ? "Enter a container image"
                      : /\s/.test(value.image.trim())
                        ? "Container images cannot contain whitespace"
                        : true,
                }}
                render={({ field }) => (
                  <FormItem className="gap-0">
                    <Accordion
                      type="multiple"
                      value={openRows}
                      onValueChange={setOpenRows}
                      className="overflow-hidden rounded-md border"
                    >
                      <ConfigurationRow
                        id={`${id}-container`}
                        value="container"
                        title="Container"
                        description="The image each run starts from."
                        summary={containerSummary(field.value)}
                        attention={imageAttention}
                      >
                        <div className="space-y-2">
                          <AgentRuntimeImageFields
                            value={field.value}
                            onChange={(value) =>
                              field.onChange({ ...value, privileged: false })
                            }
                          />
                          <FormMessage />
                        </div>
                      </ConfigurationRow>
                      <ConfigurationRow
                        id={`${id}-inference`}
                        value="inference"
                        title="Inference API"
                        description="How the client calls models."
                        summary={
                          AGENT_RUNTIME_PROTOCOL_LABELS[
                            field.value.inferenceProtocol
                          ]
                        }
                      >
                        <AgentRuntimeProtocolField
                          value={field.value}
                          onChange={field.onChange}
                          hideLabel
                        />
                      </ConfigurationRow>
                      <ConfigurationRow
                        id={`${id}-steering`}
                        value="steering"
                        title="Follow-up messages"
                        description="Messages sent while it works."
                        summary={
                          field.value.steerMode === "tmux_keys"
                            ? "Typed into its terminal"
                            : "Delivered between turns"
                        }
                      >
                        <AgentRuntimeSteeringField
                          value={field.value}
                          onChange={field.onChange}
                          hideLabel
                        />
                      </ConfigurationRow>
                      <ConfigurationRow
                        id={`${id}-environment`}
                        value="environment"
                        title="Environment"
                        description="Variables and credentials."
                        summary={environmentSummary(field.value)}
                      >
                        <AgentRuntimeEnvironmentFields
                          value={field.value}
                          onChange={field.onChange}
                          hideLabel
                          hideDescription
                        />
                      </ConfigurationRow>
                      <ConfigurationRow
                        id={`${id}-limits`}
                        value="limits"
                        title="Limits"
                        description="Run time and spend."
                        summary={limits}
                      >
                        <AgentRuntimeLimitFields
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </ConfigurationRow>
                    </Accordion>
                  </FormItem>
                )}
              />
            </DialogBody>
            <DialogFooter className="sm:items-center">
              <FormField
                control={form.control}
                name="locked"
                render={({ field }) => (
                  <FooterLock
                    checked={field.value ?? false}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">
                {template ? "Save runtime" : "Add runtime"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function BuiltInRuntimeDialog({
  id,
  image,
  value,
  onClose,
  onSave,
}: {
  id: AgentCatalogId;
  image: string;
  value: BuiltInRuntime | undefined;
  onClose: () => void;
  onSave: (value: BuiltInRuntime) => void;
}) {
  const name = AGENT_CATALOG_NAMES[id];
  const [runtime, setRuntime] = useState<AgentRuntimeConfig>(() =>
    withAgentRuntimeDefaults({
      runtime: buildAgentCatalogRuntime({ id, image }),
      defaults: value?.settings,
    }),
  );
  const [locked, setLocked] = useState(value?.locked ?? false);
  const rowId = useId();
  const limits = useLimitsSummary(runtime);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          // Focus the dialog itself: its first control is a row, whose focus
          // ring would show before anything was done.
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>Edit {name}</DialogTitle>
            <RuntimeKindLabel builtIn />
          </div>
          <DialogDescription>Defaults for new {name} agents.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Accordion
            type="multiple"
            className="overflow-hidden rounded-md border"
          >
            <ConfigurationRow
              id={`${rowId}-container`}
              value="container"
              title="Container"
              description="The maintained image and client."
              summary={containerSummary(runtime)}
            >
              <FieldDescription>
                {name} runs the image {image}, kept up to date with each
                release.
              </FieldDescription>
            </ConfigurationRow>
            {runtime.claudeCode && (
              <ConfigurationRow
                id={`${rowId}-account`}
                value="account"
                title="Claude account"
                description="Whose account runs the model."
                summary={
                  CLAUDE_ACCOUNT_LABELS[runtime.claudeCode.authentication]
                }
              >
                <ClaudeAccountField
                  value={runtime.claudeCode.authentication}
                  onChange={(authentication) =>
                    setRuntime({
                      ...runtime,
                      claudeCode: { ...runtime.claudeCode, authentication },
                    })
                  }
                />
              </ConfigurationRow>
            )}
            <ConfigurationRow
              id={`${rowId}-limits`}
              value="limits"
              title="Limits"
              description="Run time and spend."
              summary={limits}
            >
              <AgentRuntimeLimitFields value={runtime} onChange={setRuntime} />
            </ConfigurationRow>
          </Accordion>
        </DialogBody>
        <DialogFooter className="sm:items-center">
          <FooterLock checked={locked} onCheckedChange={setLocked} />
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() =>
              onSave({
                locked,
                settings: {
                  ttlHours: runtime.ttlHours,
                  maxCostUsd: runtime.maxCostUsd,
                  idleTimeoutMinutes: runtime.idleTimeoutMinutes,
                  ...(runtime.claudeCode && {
                    claudeCode: {
                      authentication: runtime.claudeCode.authentication,
                    },
                  }),
                },
              })
            }
          >
            Save runtime
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClaudeAccountField({
  value,
  onChange,
}: {
  value: "provider" | "subscription";
  onChange: (value: "provider" | "subscription") => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="sr-only">
        Claude account
      </Label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as "provider" | "subscription")}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="subscription">
            {CLAUDE_ACCOUNT_LABELS.subscription}
          </SelectItem>
          <SelectItem value="provider">
            {CLAUDE_ACCOUNT_LABELS.provider}
          </SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription>
        Each person signs in with their own Pro or Max plan, or runs are billed
        to an LLM provider connection.
      </FieldDescription>
    </div>
  );
}

function Permission({ children }: { children: string }) {
  return (
    <code className="rounded-sm bg-muted px-1 py-px font-mono text-[0.85em]">
      {children}
    </code>
  );
}

/** Whether a runtime is one of the maintained ones or the organization's own. */
function RuntimeKindLabel({ builtIn }: { builtIn: boolean }) {
  const Icon = builtIn ? BadgeCheck : Box;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
        builtIn
          ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
          : "bg-violet-500/10 text-violet-700 dark:text-violet-300",
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {builtIn ? "Built-in" : "Custom"}
    </span>
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

function FooterLock({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-3 py-1 sm:mr-auto">
      <Switch
        id={id}
        className="mt-0.5"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="flex items-center gap-1.5">
          <LockKeyhole
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-colors",
              checked ? "text-foreground" : "text-muted-foreground",
            )}
          />
          Lock settings
        </Label>
        <p className="text-xs text-muted-foreground">
          {checked ? (
            <>
              Every agent uses these; change them here with{" "}
              <Permission>organizationSettings:update</Permission>.
            </>
          ) : (
            <>
              Changeable per agent with{" "}
              <Permission>agent:configure-runtime</Permission>.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function containerSummary(value: AgentRuntimeConfig): string {
  const image = value.image.trim().split("/").slice(-2).join("/");
  if (!image) return "No image set";
  return value.command?.length ? `${image}, ${value.command[0]}` : image;
}

function environmentSummary(value: AgentRuntimeConfig): string {
  const variables = value.environment?.length ?? 0;
  const credentials = value.credentials?.length ?? 0;
  const parts = [];
  if (variables)
    parts.push(`${variables} ${variables === 1 ? "variable" : "variables"}`);
  if (credentials)
    parts.push(
      `${credentials} ${credentials === 1 ? "credential" : "credentials"}`,
    );
  return parts.length ? parts.join(", ") : "None";
}

function useLimitsSummary(value: AgentRuntimeConfig): string {
  const defaults = useFeature("agentRuntimeBackend");
  const idle = value.idleTimeoutMinutes ?? defaults?.defaultIdleTimeoutMinutes;
  const ttl = value.ttlHours ?? defaults?.defaultTtlHours;
  const parts = [];
  if (idle != null) parts.push(`${idle} min idle`);
  if (ttl != null) parts.push(`${ttl} h`);
  return parts.length ? parts.join(" · ") : "Installation defaults";
}

const CLAUDE_ACCOUNT_LABELS = {
  subscription: "Each person's Claude subscription",
  provider: "A company API key",
} as const;
