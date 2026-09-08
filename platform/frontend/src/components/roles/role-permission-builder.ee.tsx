"use client";

import {
  type Action,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
} from "@archestra/shared";
import { allAvailableActions } from "@archestra/shared/access-control";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface RolePermissionBuilderProps {
  permission: Permissions;
  onChange: (permission: Permissions) => void;
  userPermissions: Permissions;
  readOnly?: boolean;
  readOnlyTooltip?: string;
}

// Human-readable labels for actions
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

const UNGRANTABLE_PERMISSION_TOOLTIP =
  "You can only grant permissions that you currently have yourself.";

export function RolePermissionBuilder({
  permission,
  onChange,
  userPermissions,
  readOnly = false,
  readOnlyTooltip,
}: RolePermissionBuilderProps) {
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(),
  );

  const toggleCategory = useCallback(
    (category: string) => {
      const newExpanded = new Set(expandedCategories);
      if (newExpanded.has(category)) {
        newExpanded.delete(category);
      } else {
        newExpanded.add(category);
      }
      setExpandedCategories(newExpanded);
    },
    [expandedCategories],
  );

  const toggleAction = useCallback(
    (resource: Resource, action: Action) => {
      const currentActions = permission[resource] || [];
      const newActions = currentActions.includes(action)
        ? currentActions.filter((a) => a !== action)
        : [...currentActions, action];

      if (newActions.length === 0) {
        // Remove resource if no actions selected
        const newPermission = { ...permission };
        delete newPermission[resource];
        onChange(newPermission);
      } else {
        onChange({
          ...permission,
          [resource]: newActions,
        });
      }
    },
    [permission, onChange],
  );

  const selectAllForResource = useCallback(
    (resource: Resource) => {
      const availableActions = userPermissions[resource] || [];
      onChange({
        ...permission,
        [resource]: [...availableActions],
      });
    },
    [permission, onChange, userPermissions],
  );

  const deselectAllForResource = useCallback(
    (resource: Resource) => {
      const newPermission = { ...permission };
      delete newPermission[resource];
      onChange(newPermission);
    },
    [permission, onChange],
  );

  const isResourceFullySelected = useCallback(
    (resource: Resource): boolean => {
      const currentActions = permission[resource] || [];
      const availableActions = userPermissions[resource] || [];
      return (
        currentActions.length === availableActions.length &&
        availableActions.length > 0
      );
    },
    [permission, userPermissions],
  );

  const isResourcePartiallySelected = useCallback(
    (resource: Resource): boolean => {
      const currentActions = permission[resource] || [];
      return currentActions.length > 0 && !isResourceFullySelected(resource);
    },
    [permission, isResourceFullySelected],
  );

  const getTotalPermissionCount = useCallback((): number => {
    return Object.values(permission).reduce(
      (sum, actions) => sum + actions.length,
      0,
    );
  }, [permission]);

  // Check if all resources in a category are fully selected
  const isCategoryFullySelected = useCallback(
    (category: string): boolean => {
      const resources = resourceCategories[category] || [];
      const visibleResources = resources.filter(
        (resource) => userPermissions[resource],
      );

      if (visibleResources.length === 0) {
        return false;
      }

      return visibleResources.every((resource) => {
        return isResourceFullySelected(resource);
      });
    },
    [userPermissions, isResourceFullySelected],
  );

  const getResourceCheckState = useCallback(
    (resource: Resource): boolean | "indeterminate" => {
      if (isResourceFullySelected(resource)) {
        return true;
      }

      if (isResourcePartiallySelected(resource)) {
        return "indeterminate";
      }

      return false;
    },
    [isResourceFullySelected, isResourcePartiallySelected],
  );

  const getCategoryCheckState = useCallback(
    (category: string): boolean | "indeterminate" => {
      if (isCategoryFullySelected(category)) {
        return true;
      }

      const resources = resourceCategories[category] || [];
      const hasSelectedResource = resources.some((resource) => {
        const currentActions = permission[resource] || [];
        return currentActions.length > 0;
      });

      if (hasSelectedResource) {
        return "indeterminate";
      }

      return false;
    },
    [isCategoryFullySelected, permission],
  );

  // Select all permissions for all resources in a category
  const selectAllForCategory = useCallback(
    (category: string) => {
      const resources = resourceCategories[category] || [];
      const visibleResources = resources.filter(
        (resource) => userPermissions[resource],
      );

      const newPermission = { ...permission };
      visibleResources.forEach((resource) => {
        const availableActions = userPermissions[resource] || [];
        if (availableActions.length > 0) {
          newPermission[resource] = [...availableActions];
        }
      });

      onChange(newPermission);
    },
    [permission, onChange, userPermissions],
  );

  // Deselect all permissions for all resources in a category
  const deselectAllForCategory = useCallback(
    (category: string) => {
      const resources = resourceCategories[category] || [];
      const visibleResources = resources.filter(
        (resource) => userPermissions[resource],
      );

      const newPermission = { ...permission };
      visibleResources.forEach((resource) => {
        delete newPermission[resource];
      });

      onChange(newPermission);
    },
    [permission, onChange, userPermissions],
  );

  const query = search.trim().toLowerCase();
  const visibleCategories = Object.entries(resourceCategories)
    .map(([category, resources]) => ({
      category,
      resources: resources.filter((resource) => {
        if (selectedOnly && !permission[resource]?.length) return false;
        return (
          !query ||
          [
            category,
            resource,
            resourceLabels[resource],
            resourceDescriptions[resource],
            ...(allAvailableActions[resource] ?? []).map(
              (action) => actionLabels[action],
            ),
          ].some((text) => text?.toLowerCase().includes(query))
        );
      }),
    }))
    .filter(({ resources }) => resources.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          <span className="font-medium tabular-nums text-foreground">
            {getTotalPermissionCount()}
          </span>{" "}
          <span>
            {getTotalPermissionCount() === 1 ? "permission" : "permissions"}{" "}
            across {Object.keys(permission).length}{" "}
            {Object.keys(permission).length === 1 ? "resource" : "resources"}
          </span>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange({})}
          disabled={readOnly || getTotalPermissionCount() === 0}
          title={readOnly ? readOnlyTooltip : undefined}
        >
          Clear All
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search permissions"
            placeholder="Search resources or actions…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          type="button"
          variant={selectedOnly ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={selectedOnly}
          onClick={() => setSelectedOnly(!selectedOnly)}
        >
          Selected only
        </Button>
      </div>
      <div className="divide-y border-y">
        {visibleCategories.map(({ category, resources }) => {
          const expanded =
            !!query || selectedOnly || expandedCategories.has(category);
          const categoryCount = (resourceCategories[category] ?? []).reduce(
            (sum, resource) => sum + (permission[resource]?.length ?? 0),
            0,
          );
          return (
            <section key={category}>
              <div className="flex items-center gap-3 py-3">
                <Checkbox
                  aria-label={`${category} permissions`}
                  checked={getCategoryCheckState(category)}
                  disabled={readOnly}
                  onCheckedChange={(checked) =>
                    checked
                      ? selectAllForCategory(category)
                      : deselectAllForCategory(category)
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={category}
                  aria-expanded={expanded}
                  onClick={() => toggleCategory(category)}
                  className="h-auto flex-1 justify-between px-0 py-1 hover:bg-transparent"
                >
                  <span className="font-medium">{category}</span>
                  <span className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
                    <span>
                      {categoryCount
                        ? `${categoryCount} selected`
                        : `${resources.length} resources`}
                    </span>
                    {expanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </span>
                </Button>
              </div>
              {expanded && (
                <div className="divide-y pl-7">
                  {resources.map((resource) => {
                    const availableActions = userPermissions[resource] || [];
                    const selectedActions = permission[resource] || [];
                    return (
                      <div
                        key={resource}
                        className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            className="mt-0.5"
                            id={`${resource}-all`}
                            aria-label={`${resourceLabels[resource] || resource} permissions`}
                            checked={getResourceCheckState(resource)}
                            disabled={readOnly}
                            onCheckedChange={(checked) =>
                              checked
                                ? selectAllForResource(resource)
                                : deselectAllForResource(resource)
                            }
                          />
                          <div className="min-w-0">
                            <Label
                              htmlFor={`${resource}-all`}
                              className="cursor-pointer font-medium"
                            >
                              {resourceLabels[resource] || resource}
                            </Label>
                            {resourceDescriptions[resource] && (
                              <FieldDescription className="mt-1 text-xs leading-relaxed">
                                {resourceDescriptions[resource]}
                              </FieldDescription>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap content-start gap-x-4 gap-y-3">
                          {(allAvailableActions[resource] || []).map(
                            (action) => {
                              const isSelected =
                                selectedActions.includes(action);
                              const canGrantAction =
                                availableActions.includes(action);
                              const shouldDisableAction =
                                readOnly || (!canGrantAction && !isSelected);
                              return (
                                <Tooltip key={action}>
                                  <TooltipTrigger asChild>
                                    <div className="flex items-center gap-2">
                                      <Checkbox
                                        id={`${resource}-${action}`}
                                        checked={isSelected}
                                        disabled={shouldDisableAction}
                                        onCheckedChange={() =>
                                          toggleAction(resource, action)
                                        }
                                      />
                                      <Label
                                        htmlFor={`${resource}-${action}`}
                                        className={`whitespace-nowrap text-sm font-normal ${shouldDisableAction ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer"}`}
                                      >
                                        {actionLabels[action]}
                                      </Label>
                                    </div>
                                  </TooltipTrigger>
                                  {shouldDisableAction &&
                                    !readOnly &&
                                    !canGrantAction && (
                                      <TooltipContent>
                                        {UNGRANTABLE_PERMISSION_TOOLTIP}
                                      </TooltipContent>
                                    )}
                                </Tooltip>
                              );
                            },
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
        {visibleCategories.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {selectedOnly
              ? "No selected permissions match your search."
              : "No matching permissions."}
          </p>
        )}
      </div>
    </div>
  );
}
