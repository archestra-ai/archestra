// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type Action,
  type archestraApiTypes,
  isPermissionActionGranted,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
} from "@archestra/shared";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { usePermissionSources } from "@/lib/auth/permission-sources.query";
import { formatRoleName } from "@/lib/utils/role";

export function PermissionsCard() {
  const { data: permissions, isLoading } = useAllPermissions();
  const { data: sources = [] } = usePermissionSources();
  const [filter, setFilter] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(),
  );

  const granted = useMemo(
    () => groupGrantedResources(permissions),
    [permissions],
  );
  const matches = useMemo(
    () => filterGroups({ groups: granted, filter, permissions }),
    [granted, filter, permissions],
  );

  const toggleCategory = useCallback((category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const totalResources = granted.reduce(
    (sum, group) => sum + group.resources.length,
    0,
  );
  const isFiltering = filter.trim().length > 0;
  const allExpanded =
    granted.length > 0 && expandedCategories.size === granted.length;

  return (
    <SettingsBlock
      title="Your Permissions"
      description={`Permissions from your direct roles and team memberships — ${totalResources} resources across ${granted.length} categories.`}
      control={
        granted.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setExpandedCategories(
                allExpanded
                  ? new Set()
                  : new Set(granted.map((group) => group.category)),
              )
            }
          >
            <span>{allExpanded ? "Collapse all" : "Expand all"}</span>
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        {totalResources === 0 ? (
          <p className="text-sm text-muted-foreground">
            Your roles and teams grant no resource permissions.
          </p>
        ) : (
          <>
            <div className="relative sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter permissions by resource or action"
                aria-label="Filter permissions"
                className="pl-9"
              />
            </div>
            {matches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No permissions match that filter.
              </p>
            ) : (
              <div className="divide-y border-y">
                {matches.map(({ category, resources }) => (
                  <CategorySection
                    key={category}
                    category={category}
                    resources={resources}
                    permissions={permissions as Permissions}
                    sources={sources}
                    // A filter narrows things down to what the reader asked
                    // for, so keep those open instead of making them expand
                    // each hit by hand.
                    isExpanded={isFiltering || expandedCategories.has(category)}
                    onToggle={toggleCategory}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </SettingsBlock>
  );
}

function CategorySection({
  category,
  resources,
  permissions,
  sources,
  isExpanded,
  onToggle,
}: {
  category: string;
  resources: Resource[];
  permissions: Permissions;
  sources: archestraApiTypes.GetUserPermissionSourcesResponses["200"];
  isExpanded: boolean;
  onToggle: (category: string) => void;
}) {
  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle(category)}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-3 text-left text-muted-foreground transition-colors hover:text-foreground">
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        <span className="text-sm font-medium text-foreground">{category}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {resources.length} resource
          {resources.length !== 1 ? <span>s</span> : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y pb-2 pl-6">
          {resources.map((resource) => {
            const actions = permissions[resource] || [];
            return (
              <div
                key={resource}
                className="grid gap-2 py-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)] sm:items-center sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-tight">
                    {resourceLabels[resource] || resource}
                  </p>
                  {resourceDescriptions[resource] && (
                    <p className="text-xs text-muted-foreground leading-tight mt-0.5">
                      {resourceDescriptions[resource]}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 sm:justify-end">
                  {actions.map((action) => (
                    <Tooltip key={action}>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          tabIndex={0}
                          className="cursor-help text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {actionLabels[action] || action}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm space-y-1">
                        <p className="font-medium">Granted by</p>
                        {sources
                          .filter((source) =>
                            isPermissionActionGranted({
                              resource,
                              grantedActions:
                                source.permissions[resource] ?? [],
                              requiredAction: action,
                            }),
                          )
                          .map((source) => (
                            <p
                              key={`${source.team?.id ?? "direct"}:${source.role}`}
                              className="text-xs"
                            >
                              {formatRoleName(source.role)} ·{" "}
                              {source.team
                                ? `Team: ${source.team.name}`
                                : "Direct assignment"}
                            </p>
                          ))}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type PermissionGroup = { category: string; resources: Resource[] };

function groupGrantedResources(
  permissions: Permissions | null | undefined,
): PermissionGroup[] {
  if (!permissions) return [];

  return Object.entries(resourceCategories)
    .map(([category, resources]) => ({
      category,
      resources: resources.filter(
        (resource) => (permissions[resource]?.length ?? 0) > 0,
      ),
    }))
    .filter(({ resources }) => resources.length > 0);
}

function filterGroups({
  groups,
  filter,
  permissions,
}: {
  groups: PermissionGroup[];
  filter: string;
  permissions: Permissions | null | undefined;
}): PermissionGroup[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return groups;

  return groups
    .map(({ category, resources }) => ({
      category,
      resources: resources.filter((resource) =>
        [
          category,
          resource,
          resourceLabels[resource],
          resourceDescriptions[resource],
          ...(permissions?.[resource] ?? []).map(
            (action) => actionLabels[action] ?? action,
          ),
        ]
          .filter(Boolean)
          .some((haystack) => haystack.toLowerCase().includes(needle)),
      ),
    }))
    .filter(({ resources }) => resources.length > 0);
}

const actionLabels: Record<Action, string> = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Delete",
  "team-admin": "Team Admin",
  admin: "Admin",
  cancel: "Cancel",
  enable: "Enable",
  query: "Query",
  execute: "Execute",
  "deploy-to-restricted": "Deploy to Restricted",
  manage: "Manage",
  "manage-deleted": "Manage Deleted",
  "read-all": "Read All Chats",
  "share-org": "Share Org-Wide",
  impersonate: "Impersonate",
};
