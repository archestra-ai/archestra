// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  E2eTestId,
  getIdpRoleMappingRuleRowTestId,
  type IdentityProviderFormValues,
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RoleSelect } from "@/components/ui/role-select";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";
import { IdentityProviderSectionHeader } from "./identity-provider-section-header.ee";
import { SsoTemplateDebugSection } from "./sso-template-debug-section.ee";

interface RoleMappingFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
  identityProviderId?: string;
  embedded?: boolean;
}

export function RoleMappingForm({
  form,
  identityProviderId,
  embedded = false,
}: RoleMappingFormProps) {
  const appName = useAppName();
  const { fields, append, move, remove } = useFieldArray({
    control: form.control,
    name: "roleMapping.rules",
  });
  const roleMappingRules = form.watch("roleMapping.rules") ?? [];
  const defaultRole = form.watch("roleMapping.defaultRole") || "member";
  const strictMode = form.watch("roleMapping.strictMode") || false;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const moveRule = (fromIndex: number, toIndex: number) => {
    if (fromIndex !== toIndex) move(fromIndex, toIndex);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const fromIndex = fields.findIndex((field) => field.id === active.id);
    const toIndex = fields.findIndex((field) => field.id === over.id);
    if (fromIndex === -1 || toIndex === -1) return;

    moveRule(fromIndex, toIndex);
  };

  const content = (
    <>
      <IdentityProviderSectionHeader title="Role Mapping">
        Assign organization roles from sign-in data. The first matching rule
        wins.
      </IdentityProviderSectionHeader>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <FormLabel>Mapping Rules</FormLabel>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ expression: "", role: "member" })}
            data-testid={E2eTestId.IdpRoleMappingAddRule}
          >
            <Plus className="mr-1 h-4 w-4" />
            Add Rule
          </Button>
        </div>

        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mapping rules configured. All users will be assigned the default
            roles.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={fields.map((field) => field.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-3 list-none p-0 m-0">
                {fields.map((field, index) => (
                  <RoleMappingRuleRow
                    key={field.id}
                    appName={appName}
                    fieldId={field.id}
                    fieldsLength={fields.length}
                    form={form}
                    index={index}
                    onRemove={() => remove(index)}
                    onMoveDown={() => moveRule(index, index + 1)}
                    onMoveUp={() => moveRule(index, index - 1)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <SsoTemplateDebugSection
        identityProviderId={identityProviderId}
        mode="role"
        template={roleMappingRules[0]?.expression}
        templateLabel="Role mapping"
        roleRules={roleMappingRules}
        defaultRole={defaultRole}
        strictMode={strictMode}
      />
      <div className="space-y-4 border-t pt-4">
        <FormField
          control={form.control}
          name="roleMapping.defaultRole"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Default Roles</FormLabel>
              <FormDescription>
                Roles assigned when no mapping rules match.
              </FormDescription>
              <FormControl>
                <RoleSelect
                  multiple
                  ariaLabel="Default Roles"
                  value={field.value || "member"}
                  onValueChange={field.onChange}
                  placeholder="Select default roles"
                  data-testid={E2eTestId.IdpRoleMappingDefaultRole}
                  className="w-full"
                  restrictToGrantable={false}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="roleMapping.strictMode"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value || false}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none">
                  <FormLabel>Strict Mode</FormLabel>
                  <FormDescription>
                    Deny sign-in when no rule matches.
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="roleMapping.skipRoleSync"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value || false}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none">
                  <FormLabel>Skip Role Sync</FormLabel>
                  <FormDescription>
                    Set roles on first sign-in only. Keep later role changes.
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />
        </div>
      </div>
    </>
  );

  return <div className={embedded ? "space-y-4" : "space-y-6"}>{content}</div>;
}

function RoleMappingRuleRow({
  appName,
  fieldId,
  fieldsLength,
  form,
  index,
  onMoveDown,
  onMoveUp,
  onRemove,
}: {
  appName: string;
  fieldId: string;
  fieldsLength: number;
  form: UseFormReturn<IdentityProviderFormValues>;
  index: number;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: fieldId,
    disabled: fieldsLength < 2,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "@container flex items-start gap-2 p-3 border rounded-md",
        isDragging && "relative z-10 opacity-70 shadow-md",
      )}
      data-testid={getIdpRoleMappingRuleRowTestId(index)}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Drag role mapping rule ${index + 1}`}
        className="size-7 shrink-0 mt-6 cursor-grab text-muted-foreground active:cursor-grabbing"
        disabled={fieldsLength < 2}
        {...attributes}
        {...listeners}
        onKeyDown={(event) => {
          listeners?.onKeyDown?.(event);
          if (event.key === "ArrowUp" && index > 0) {
            event.preventDefault();
            onMoveUp();
          }
          if (event.key === "ArrowDown" && index < fieldsLength - 1) {
            event.preventDefault();
            onMoveDown();
          }
        }}
      >
        <GripVertical className="h-4 w-4" />
      </Button>
      <div className="grid grid-cols-1 items-start gap-3 w-full flex-1 min-w-0 @[600px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <FormField
          control={form.control}
          name={`roleMapping.rules.${index}.expression`}
          render={({ field }) => (
            <FormItem className="min-w-0 space-y-1.5">
              <div className="flex min-h-5 items-center gap-2">
                <FormLabel className="text-xs">Handlebars Template</FormLabel>
              </div>
              <FormControl>
                <Input
                  placeholder='{{#includes groups "admin"}}true{{/includes}}'
                  className="h-9 font-mono text-sm"
                  data-testid={E2eTestId.IdpRoleMappingRuleTemplate}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={`roleMapping.rules.${index}.role`}
          render={({ field }) => (
            <FormItem className="min-w-0 space-y-1.5">
              <div className="flex min-h-5 items-center">
                <FormLabel className="text-xs">Roles</FormLabel>
              </div>
              <FormControl>
                <RoleSelect
                  multiple
                  maxBadgeDisplay={1}
                  ariaLabel={`${appName} roles for rule ${index + 1}`}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder="Select roles"
                  data-testid={E2eTestId.IdpRoleMappingRuleRole}
                  className="h-9 w-full min-w-0 flex-nowrap overflow-hidden"
                  restrictToGrantable={false}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <Button
        type="button"
        aria-label="Remove role mapping"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 mt-6 text-destructive hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}
