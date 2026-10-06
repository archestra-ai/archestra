// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type Action,
  type archestraApiTypes,
  isPermissionActionGranted,
  ManagedResourceSchema,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
} from "@archestra/shared";
import {
  allAvailableActions,
  permissionDescriptions,
  roleActionResourceFor,
} from "@archestra/shared/access-control";
import { Check, Info } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRoleName } from "@/lib/utils/role";
import { cn } from "@/lib/utils/tailwind";

/** The same compact permission vocabulary for roles and personal access. */
export function PermissionExplorer({
  permissions,
  onChange,
  grantable = {},
  sources,
}: {
  permissions: Permissions;
  onChange?: (permissions: Permissions) => void;
  grantable?: Permissions;
  sources?: archestraApiTypes.GetUserPermissionSourcesResponses["200"];
}) {
  const [category, setCategory] = useState<string | null>(null);
  const editable = !!onChange;
  const groups = Object.entries(resourceCategories)
    .map(([name, resources]) => ({
      name,
      resources: resources.filter(
        (resource) => editable || permissions[resource]?.length,
      ),
    }))
    .filter((group) => group.resources.length > 0);
  const active =
    groups.find((group) => group.name === category) ??
    groups.find((group) =>
      group.resources.some((resource) => permissions[resource]?.length),
    ) ??
    groups[0];
  const visible = active ? [active] : [];

  const toggleAction = (resource: Resource, action: Action) => {
    const selected = permissions[resource] ?? [];
    const actions = selected.includes(action)
      ? selected.filter((entry) => entry !== action)
      : [...selected, action];
    const next = { ...permissions };
    if (actions.length) next[resource] = actions;
    else delete next[resource];
    onChange?.(next);
  };
  const toggleResources = (resources: Resource[], checked: boolean) => {
    const next = { ...permissions };
    for (const resource of resources) {
      if (checked) {
        // Keep existing stronger grants. Bulk selection may only ADD actions
        // the author holds; it must not silently replace a role's other actions.
        const actions = [
          ...new Set([
            ...(permissions[resource] ?? []),
            ...allAvailableActions[resource].filter((action) =>
              grantable[resource]?.includes(action),
            ),
          ]),
        ];
        if (actions.length) next[resource] = actions;
      } else delete next[resource];
    }
    onChange?.(next);
  };
  const checkState = (resources: Resource[]): boolean | "indeterminate" => {
    const entries = resources.flatMap((resource) =>
      allAvailableActions[resource]
        .filter(
          (action) =>
            grantable[resource]?.includes(action) ||
            permissions[resource]?.includes(action),
        )
        .map((action) => permissions[resource]?.includes(action) ?? false),
    );
    return entries.length && entries.every(Boolean)
      ? true
      : entries.some(Boolean)
        ? "indeterminate"
        : false;
  };
  const cannotSelect = (resources: Resource[]) =>
    !resources.some(
      (resource) =>
        (permissions[resource]?.length ?? 0) > 0 ||
        allAvailableActions[resource].some((action) =>
          grantable[resource]?.includes(action),
        ),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {groups.length ? (
        <div className="grid min-h-0 flex-1 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-0">
          <nav
            aria-label="Permission categories"
            className="flex flex-wrap content-start gap-1 sm:flex-col sm:gap-0.5 sm:border-r sm:pr-3"
          >
            {groups.map((group) => {
              const selected = group.resources.reduce(
                (sum, resource) => sum + (permissions[resource]?.length ?? 0),
                0,
              );
              return (
                <Button
                  key={group.name}
                  type="button"
                  variant="ghost"
                  aria-label={group.name}
                  aria-current={
                    active?.name === group.name ? "page" : undefined
                  }
                  onClick={() => {
                    setCategory(group.name);
                  }}
                  className={cn(
                    "h-8 justify-between gap-3 px-2.5 text-xs font-normal sm:h-7 sm:w-full",
                    active?.name === group.name &&
                      "bg-muted font-medium text-foreground",
                  )}
                >
                  <span>{group.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {selected}
                  </span>
                </Button>
              );
            })}
          </nav>
          <div className="min-w-0 space-y-5 sm:pl-5">
            {visible.map((group) => (
              <section key={group.name} aria-label={`${group.name} resources`}>
                <div
                  className="hidden grid-cols-[minmax(8rem,1fr)_repeat(4,3rem)_minmax(4rem,0.8fr)] items-center gap-1 border-b pb-2 text-[11px] text-muted-foreground sm:grid"
                  aria-hidden="true"
                >
                  <span>Resource</span>
                  {standardActions.map((action) => (
                    <span key={action} className="text-center">
                      {actionLabels[action]}
                    </span>
                  ))}
                  <span className="pl-2">Other</span>
                </div>
                <div className="divide-y divide-border/50">
                  {group.resources.map((resource) => {
                    const label = resourceLabels[resource];
                    const actions = allAvailableActions[resource];
                    const extra = actions.filter(
                      (action) => !standardActions.includes(action),
                    );
                    return (
                      <fieldset
                        key={resource}
                        className="grid min-w-0 gap-y-2 py-3 sm:grid-cols-[minmax(8rem,1fr)_repeat(4,3rem)_minmax(4rem,0.8fr)] sm:items-center sm:gap-x-1 sm:py-1"
                        aria-label={`${label} actions`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {editable && (
                            <Checkbox
                              aria-label={`${label} permissions`}
                              checked={checkState([resource])}
                              disabled={cannotSelect([resource])}
                              onCheckedChange={(checked) =>
                                toggleResources([resource], checked === true)
                              }
                            />
                          )}
                          {/* The label takes the slack so every row's info
                              icon lands in the same column. */}
                          <span className="min-w-0 flex-1 text-[13px] font-medium">
                            {label}
                          </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`${label} details`}
                                className="shrink-0 text-muted-foreground"
                              >
                                <Info className="size-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p>{resourceDescriptions[resource]}</p>
                              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                                {resource}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:contents">
                          {standardActions.map((action) =>
                            actions.includes(action) ? (
                              <PermissionAction
                                key={action}
                                resource={resource}
                                action={action}
                                selected={
                                  permissions[resource]?.includes(action) ??
                                  false
                                }
                                editable={editable}
                                canGrant={
                                  grantable[resource]?.includes(action) ?? false
                                }
                                onToggle={() => toggleAction(resource, action)}
                                sources={sources}
                              />
                            ) : (
                              <span
                                key={action}
                                className="hidden text-center text-xs text-muted-foreground/50 sm:block"
                              >
                                <span aria-hidden="true">·</span>
                                <span className="sr-only">
                                  {label} {actionLabels[action]} unavailable
                                </span>
                              </span>
                            ),
                          )}
                          <div className="flex flex-wrap items-center gap-1 sm:pl-2">
                            {extra
                              .filter(
                                (action) =>
                                  editable ||
                                  permissions[resource]?.includes(action),
                              )
                              .map((action) => (
                                <PermissionAction
                                  key={action}
                                  resource={resource}
                                  action={action}
                                  selected={
                                    permissions[resource]?.includes(action) ??
                                    false
                                  }
                                  editable={editable}
                                  canGrant={
                                    grantable[resource]?.includes(action) ??
                                    false
                                  }
                                  onToggle={() =>
                                    toggleAction(resource, action)
                                  }
                                  sources={sources}
                                  named
                                />
                              ))}
                          </div>
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
                {group.resources.some((resource) =>
                  PER_ITEM_RESOURCES.has(resource),
                ) && (
                  <p className="pt-3 text-xs text-muted-foreground">
                    Who can see, edit, delete or share these items isn't set
                    here. Use Permissions on a single item, or Permissions in a
                    list page's ⋯ menu for all of them.
                  </p>
                )}
              </section>
            ))}
          </div>
        </div>
      ) : (
        <output className="block py-12 text-center text-sm text-muted-foreground">
          <span>No permissions granted.</span>
        </output>
      )}
    </div>
  );
}

function PermissionAction({
  resource,
  action,
  selected,
  editable,
  canGrant,
  onToggle,
  sources,
  named = false,
}: {
  resource: Resource;
  action: Action;
  selected: boolean;
  editable: boolean;
  canGrant: boolean;
  onToggle: () => void;
  sources?: archestraApiTypes.GetUserPermissionSourcesResponses["200"];
  named?: boolean;
}) {
  const controlId = useId();
  const label = actionLabels[action];
  const name = `${resourceLabels[resource]} ${label}`;
  const disabled = !canGrant && !selected;
  const grantingSources = sources?.filter((source) =>
    isPermissionActionGranted({
      resource,
      grantedActions: source.permissions[resource] ?? [],
      requiredAction: action,
    }),
  );
  if (!editable && !selected)
    return (
      <span className="hidden text-center text-xs text-muted-foreground/50 sm:block">
        <span aria-hidden="true">·</span>
        <span className="sr-only">{name} not granted</span>
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {editable ? (
          <Label
            htmlFor={controlId}
            className={cn(
              "flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs transition-colors sm:min-h-7 sm:justify-center",
              named && "sm:justify-start",
              disabled
                ? "cursor-not-allowed text-muted-foreground"
                : "cursor-pointer hover:bg-muted/60",
            )}
          >
            <Checkbox
              id={controlId}
              aria-label={name}
              checked={selected}
              disabled={disabled}
              onCheckedChange={onToggle}
            />
            <span className={cn(!named && "sm:sr-only")}>{label}</span>
          </Label>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${name} granted`}
            className={cn(
              "h-8 gap-1.5 px-1.5 text-xs font-normal sm:h-7 sm:w-full",
              named && "sm:w-auto",
            )}
          >
            <Check className="size-3.5 text-primary" />
            <span className={cn(!named && "sm:sr-only")}>{label}</span>
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1">
        {permissionDescriptions[`${resource}:${action}`] && (
          <p>{permissionDescriptions[`${resource}:${action}`]}</p>
        )}
        <p className="font-mono text-[11px] opacity-70">
          {resource}:{action}
        </p>
        {editable && disabled ? <p>{UNGRANTABLE_PERMISSION_TOOLTIP}</p> : null}
        {grantingSources?.length ? (
          <>
            <p className="font-medium">Granted by</p>
            {grantingSources.map((source) => (
              <p key={`${source.team?.id ?? "direct"}:${source.role}`}>
                {formatRoleName(source.role)} ·{" "}
                {source.team
                  ? `Team: ${source.team.name}`
                  : "Direct assignment"}
              </p>
            ))}
          </>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

const standardActions: Action[] = ["read", "create", "update", "delete"];
// Role resources whose individual items carry their own grants. Environments
// and scheduled tasks are governed organization-wide instead.
const PER_ITEM_RESOURCES = new Set<Resource>(
  ManagedResourceSchema.options
    .filter(
      (resource) => resource !== "environment" && resource !== "scheduledTask",
    )
    .map(roleActionResourceFor),
);
const UNGRANTABLE_PERMISSION_TOOLTIP =
  "You can only grant permissions that you currently have yourself.";
const actionLabels: Record<Action, string> = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Delete",
  cancel: "Cancel",
  query: "Query",
  impersonate: "Impersonate",
  "full-view": "Full view",
  admin: "Admin",
};
