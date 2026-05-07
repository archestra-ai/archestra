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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  E2eTestId,
  getIdpRoleMappingRuleRowTestId,
  type IdentityProviderFormValues,
} from "@shared";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
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
import { RoleSelectContent } from "@/components/ui/role-select";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";
import { getIdentityProviderClaimHint } from "./identity-provider-claim-hints";
import { SsoTemplateDebugSection } from "./sso-template-debug-section.ee";

interface RoleMappingFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
  identityProviderId?: string;
  embedded?: boolean;
}

const HANDLEBARS_EXAMPLES = [
  {
    expression: '{{#includes groups "admin"}}true{{/includes}}',
    description: "Match if 'admin' is in the groups array",
  },
  {
    expression: '{{#equals role "administrator"}}true{{/equals}}',
    description: "Match if role claim equals 'administrator'",
  },
  {
    expression:
      '{{#each roles}}{{#equals this "archestra-admin"}}true{{/equals}}{{/each}}',
    description: "Match if 'archestra-admin' is in roles array",
  },
  {
    expression:
      '{{#and department title}}{{#equals department "IT"}}true{{/equals}}{{/and}}',
    description: "Match IT department users with a title",
  },
];

export function RoleMappingForm({
  form,
  identityProviderId,
  embedded = false,
}: RoleMappingFormProps) {
  const appName = useAppName();
  const providerClaimHint = getIdentityProviderClaimHint(
    form.watch("providerId"),
  );
  const { fields, append, move, remove } = useFieldArray({
    control: form.control,
    name: "roleMapping.rules",
  });
  const [selectedRuleIndex, setSelectedRuleIndex] = useState(0);
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
  const activeRuleIndex =
    fields.length > 0 ? Math.min(selectedRuleIndex, fields.length - 1) : null;
  const activeRule =
    activeRuleIndex === null ? null : roleMappingRules[activeRuleIndex];
  const activeRuleLabel =
    activeRuleIndex === null
      ? "the selected role mapping rule"
      : `role mapping rule ${activeRuleIndex + 1}${activeRule?.role ? ` (${activeRule.role})` : ""}`;

  const moveRule = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    move(fromIndex, toIndex);
    setSelectedRuleIndex((currentIndex) => {
      if (currentIndex === fromIndex) return toIndex;
      if (
        fromIndex < toIndex &&
        currentIndex > fromIndex &&
        currentIndex <= toIndex
      ) {
        return currentIndex - 1;
      }
      if (
        toIndex < fromIndex &&
        currentIndex >= toIndex &&
        currentIndex < fromIndex
      ) {
        return currentIndex + 1;
      }
      return currentIndex;
    });
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
      {providerClaimHint && (
        <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
          {providerClaimHint.roleMappingNote}
        </p>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <FormLabel>Mapping Rules</FormLabel>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              append({ expression: "", role: "member" });
              setSelectedRuleIndex(fields.length);
            }}
            data-testid={E2eTestId.IdpRoleMappingAddRule}
          >
            <Plus className="mr-1 h-4 w-4" />
            Add Rule
          </Button>
        </div>

        {fields.length > 1 && (
          <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md">
            <span className="font-medium">Note:</span>
            {` `}Rules are evaluated in order from top to bottom. The first
            matching rule determines the user&apos;s role. Order your most
            specific rules first.
          </p>
        )}

        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mapping rules configured. All users will be assigned the default
            role.
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
              <ul className="space-y-4 list-none p-0 m-0">
                {fields.map((field, index) => (
                  <RoleMappingRuleRow
                    key={field.id}
                    appName={appName}
                    fieldId={field.id}
                    fieldsLength={fields.length}
                    form={form}
                    index={index}
                    isActive={activeRuleIndex === index}
                    onRemove={() => {
                      setSelectedRuleIndex((currentIndex) => {
                        if (currentIndex <= index) return currentIndex;
                        return currentIndex - 1;
                      });
                      remove(index);
                    }}
                    onMoveDown={() => moveRule(index, index + 1)}
                    onMoveUp={() => moveRule(index, index - 1)}
                    onSelect={() => setSelectedRuleIndex(index)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <FormField
        control={form.control}
        name="roleMapping.defaultRole"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Default Role</FormLabel>
            <Select
              onValueChange={field.onChange}
              value={field.value || "member"}
            >
              <FormControl>
                <SelectTrigger
                  data-testid={E2eTestId.IdpRoleMappingDefaultRole}
                >
                  <SelectValue placeholder="Select default role" />
                </SelectTrigger>
              </FormControl>
              <RoleSelectContent />
            </Select>
            <FormDescription>
              Role assigned when no mapping rules match.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <Separator className="my-4" />

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
                If enabled, denies user login when no role mapping rules match.
                Without strict mode, users who don&apos;t match any rule are
                assigned the default role.
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
                Prevent synchronizing users&apos; roles on subsequent logins.
                When enabled, the role is only set on first login, allowing
                manual role management afterward.
              </FormDescription>
            </div>
          </FormItem>
        )}
      />

      <SsoTemplateDebugSection
        identityProviderId={identityProviderId}
        mode="role"
        template={activeRule?.expression}
        templateLabel={activeRuleLabel}
        roleRules={roleMappingRules}
        defaultRole={defaultRole}
        strictMode={strictMode}
        examples={HANDLEBARS_EXAMPLES}
      />
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
  isActive,
  onMoveDown,
  onMoveUp,
  onRemove,
  onSelect,
}: {
  appName: string;
  fieldId: string;
  fieldsLength: number;
  form: UseFormReturn<IdentityProviderFormValues>;
  index: number;
  isActive: boolean;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRemove: () => void;
  onSelect: () => void;
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
        "flex items-start gap-3 p-3 border rounded-md transition-colors",
        isActive && "border-primary/50 bg-muted/20",
        isDragging && "relative z-10 opacity-70 shadow-md",
      )}
      data-testid={getIdpRoleMappingRuleRowTestId(index)}
      onPointerDown={onSelect}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Drag role mapping rule ${index + 1}`}
        className="shrink-0 mt-6 cursor-grab text-muted-foreground active:cursor-grabbing"
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
      <div className="flex items-start gap-3 w-full flex-1 min-w-0">
        <FormField
          control={form.control}
          name={`roleMapping.rules.${index}.expression`}
          render={({ field }) => (
            <FormItem className="flex-[3] min-w-0">
              <div className="flex min-h-5 items-center gap-2">
                <FormLabel className="text-xs">Handlebars Template</FormLabel>
                {isActive && (
                  <Badge variant="outline" className="px-1.5 py-0">
                    Tested below
                  </Badge>
                )}
              </div>
              <FormControl>
                <Input
                  placeholder='{{#includes groups "admin"}}true{{/includes}}'
                  className="font-mono text-sm"
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
            <FormItem className="flex-1 min-w-[220px] max-w-[360px]">
              <div className="flex min-h-5 items-center">
                <FormLabel className="text-xs">{appName} Role</FormLabel>
              </div>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger data-testid={E2eTestId.IdpRoleMappingRuleRole}>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                </FormControl>
                <RoleSelectContent />
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 mt-6 text-destructive hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}
