// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type Action,
  type archestraApiTypes,
  isPermissionActionGranted,
  ManagedResourceSchema,
  ORGANIZATION_WIDE_RESOURCES,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
  resourcePermissionPresetsFor,
  type ScopedResource,
} from "@archestra/shared";
import {
  allAvailableActions,
  permissionDescriptions,
  roleActionResourceFor,
} from "@archestra/shared/access-control";
import { Check, Info } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getListPermissionsHref } from "@/lib/resource-permissions-links";
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
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-0">
          <nav
            aria-label="Permission categories"
            className="flex flex-wrap content-start gap-1 lg:flex-col lg:gap-0.5 lg:border-r lg:pr-3"
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
                    "h-8 justify-between gap-3 px-2.5 text-xs font-normal lg:h-7 lg:w-full",
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
          <div className="min-w-0 space-y-5 lg:pl-5">
            {visible.map((group) => (
              <section key={group.name} aria-label={`${group.name} resources`}>
                <div
                  className="hidden grid-cols-[minmax(8rem,1fr)_repeat(5,5rem)_minmax(4rem,0.8fr)] items-center gap-1 border-b pb-2 text-[11px] text-muted-foreground lg:grid"
                  aria-hidden="true"
                >
                  <span>Resource</span>
                  {standardActions.map((action) => (
                    <span key={action} className="text-center">
                      {actionLabels[action]}
                    </span>
                  ))}
                  <span className="text-center">Manage access</span>
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
                        className="grid min-w-0 gap-y-2 py-3 lg:grid-cols-[minmax(8rem,1fr)_repeat(5,5rem)_minmax(4rem,0.8fr)] lg:items-center lg:gap-x-1 lg:py-1"
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
                            <TooltipContent className="w-max max-w-72 text-wrap">
                              {resourceDescriptions[resource]}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 lg:contents">
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
                              <ObjectPermissionAction
                                key={action}
                                resource={resource}
                                action={action}
                              />
                            ),
                          )}
                          <ObjectPermissionAction
                            resource={resource}
                            action="manage-permissions"
                          />
                          <div className="flex flex-wrap items-center gap-1 lg:pl-2">
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
                ) && <ObjectPermissionsNote resources={group.resources} />}
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

function ObjectPermissionsNote({ resources }: { resources: Resource[] }) {
  const links = resources.flatMap((roleResource) => {
    if (!PER_ITEM_RESOURCES.has(roleResource)) return [];
    return ManagedResourceSchema.options.flatMap((resource) => {
      if (roleActionResourceFor(resource) !== roleResource) return [];
      const href = getListPermissionsHref(resource);
      const label =
        resource === roleResource
          ? resourceLabels[roleResource]
          : (scopedResourceLabels[resource] ?? resourceLabels[roleResource]);
      return href ? [{ resource, href, label }] : [];
    });
  });
  return (
    <div className="space-y-1 pt-3 text-xs text-muted-foreground">
      <p>Per object actions are set in the item's Permissions dialog.</p>
      {links.length > 0 && (
        <p>
          For access to all current and future items, open Permissions for:{" "}
          {links.map(({ resource, href, label }, index) => (
            <span key={resource} className="inline-block">
              {index > 0 && (
                <span aria-hidden="true" className="px-1">
                  ·
                </span>
              )}
              <Link
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Permissions for all ${label} (opens in a new tab)`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {label}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}

/** Distinguish an object-controlled action from a missing role grant. */
function ObjectPermissionAction({
  resource,
  action,
}: {
  resource: Resource;
  action: Action | "manage-permissions";
}) {
  const scoped = ManagedResourceSchema.options.filter(
    (entry) => roleActionResourceFor(entry) === resource,
  );
  const allItems =
    action === "manage-permissions" &&
    scoped.some((entry) => ORGANIZATION_WIDE_RESOURCES.has(entry));
  const perObject =
    !allItems &&
    scoped.some((entry) =>
      Object.values(resourcePermissionPresetsFor(entry)).some((preset) =>
        preset.actions.some((entry) => entry === action),
      ),
    );
  const label = `${resourceLabels[resource]} ${actionLabels[action]}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={`${label}: ${allItems ? "set for all items" : perObject ? "set in object permissions" : "not applicable"}`}
        >
          <span className="lg:sr-only">{actionLabels[action]}:</span>
          <span>
            {allItems ? "All items" : perObject ? "Per object" : "N/A"}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="w-max max-w-72 text-wrap">
        {allItems
          ? `Set Manage access for all ${resourceLabels[resource]} in their organization-wide Permissions policy.`
          : perObject
            ? action === "manage-permissions"
              ? "Change who can access the item and their permission levels. Set this in the item's Permissions dialog."
              : `Set ${actionLabels[action]} in the item's Permissions dialog.`
            : `No separate ${actionLabels[action]} permission.`}
      </TooltipContent>
    </Tooltip>
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
      <span className="hidden text-center text-xs text-muted-foreground/50 lg:block">
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
              "flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs transition-colors lg:min-h-7 lg:justify-center",
              named && "lg:justify-start",
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
            <span className={cn(!named && "lg:sr-only")}>{label}</span>
          </Label>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${name} granted`}
            className={cn(
              "h-8 gap-1.5 px-1.5 text-xs font-normal lg:h-7 lg:w-full",
              named && "lg:w-auto",
            )}
          >
            <Check className="size-3.5 text-primary" />
            <span className={cn(!named && "lg:sr-only")}>{label}</span>
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent className="w-max max-w-72 space-y-1 text-wrap">
        {permissionDescriptions[`${resource}:${action}`] && (
          <p>{permissionDescriptions[`${resource}:${action}`]}</p>
        )}
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

const standardActions: Action[] = ["create", "read", "update", "delete"];
// Role resources whose individual items carry their own grants.
const PER_ITEM_RESOURCES = new Set<Resource>(
  ManagedResourceSchema.options
    .filter((resource) => !ORGANIZATION_WIDE_RESOURCES.has(resource))
    .map(roleActionResourceFor),
);
const UNGRANTABLE_PERMISSION_TOOLTIP =
  "You can only grant permissions that you currently have yourself.";
const scopedResourceLabels: Partial<Record<ScopedResource, string>> = {
  knowledgeBase: "Knowledge Bases",
  knowledgeConnector: "Connectors",
  knowledgeFile: "Files",
};
const actionLabels: Record<Action | "manage-permissions", string> = {
  "manage-permissions": "Manage access",
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
