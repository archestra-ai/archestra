"use client";

import type { Action, Permissions, Resource } from "@shared";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

interface RolePermissionBuilderProps {
  permission: Permissions;
  onChange: (permission: Permissions) => void;
  userPermissions: Permissions;
}

// Group resources by category for better organization
const resourceCategories: Record<string, Resource[]> = {
  "Core Resources": [
    "profile",
    "tool",
    "policy",
    "interaction",
    "conversation",
    "prompt",
  ],
  "MCP & Integrations": [
    "mcpServer",
    "mcpServerInstallationRequest",
    "mcpToolCall",
    "internalMcpCatalog",
  ],
  "Dual LLM": ["dualLlmConfig", "dualLlmResult"],
  Organization: [
    "organization",
    "member",
    "ac",
    "team",
    "invitation",
    "limit",
    "tokenPrice",
    "chatSettings",
    "identityProvider",
  ],
};

// Human-readable labels for resources
const resourceLabels: Record<Resource, string> = {
  profile: "Profiles",
  tool: "Tools",
  policy: "Policies",
  interaction: "Interactions",
  dualLlmConfig: "Dual LLM Configs",
  dualLlmResult: "Dual LLM Results",
  organization: "Organization",
  identityProvider: "Identity Providers",
  member: "Members",
  invitation: "Invitations",
  internalMcpCatalog: "Internal MCP Catalog",
  mcpServer: "MCP Servers",
  mcpServerInstallationRequest: "MCP Server Installation Requests",
  mcpToolCall: "MCP Tool Calls",
  team: "Teams",
  ac: "Access Control",
  conversation: "Conversations",
  limit: "Limits",
  tokenPrice: "Token Prices",
  chatSettings: "Chat Settings",
  prompt: "Prompts",
};

// Human-readable labels for actions
const actionLabels: Record<Action, string> = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Delete",
  admin: "Admin",
  cancel: "Cancel",
};

export function RolePermissionBuilder({
  permission,
  onChange,
  userPermissions,
}: RolePermissionBuilderProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(Object.keys(resourceCategories)),
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

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Selected Permissions</p>
            <p className="text-xs text-muted-foreground">
              {getTotalPermissionCount()} permission
              {getTotalPermissionCount() !== 1 ? "s" : ""} across{" "}
              {Object.keys(permission).length} resource
              {Object.keys(permission).length !== 1 ? "s" : ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange({})}
            disabled={getTotalPermissionCount() === 0}
          >
            Clear All
          </Button>
        </div>
      </Card>

      <div className="space-y-3">
        {Object.entries(resourceCategories).map(([category, resources]) => {
          const isCategorySelected = isCategoryFullySelected(category);

          return (
            <Card key={category} className="p-3">
              <div className="flex w-full items-center gap-2">
                <button
                  className="flex items-center text-left"
                  onClick={() => toggleCategory(category)}
                  type="button"
                >
                  {expandedCategories.has(category) ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                <Checkbox
                  id={`category-${category}`}
                  checked={isCategorySelected}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      selectAllForCategory(category);
                    } else {
                      deselectAllForCategory(category);
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                />
                <button
                  className="flex-1 text-left"
                  onClick={() => toggleCategory(category)}
                  type="button"
                >
                  <span className="font-semibold text-sm">{category}</span>
                </button>
              </div>

              {expandedCategories.has(category) && (
                <div className="mt-3 space-y-2">
                  {resources
                    .filter((resource) => userPermissions[resource]) // Only show resources user has permission for
                    .map((resource) => {
                      const availableActions = userPermissions[resource] || [];
                      const selectedActions = permission[resource] || [];
                      const isFullySelected = isResourceFullySelected(resource);
                      const isPartiallySelected =
                        isResourcePartiallySelected(resource);

                      return (
                        <div
                          key={resource}
                          className="rounded-md border bg-card p-3"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Checkbox
                                id={`${resource}-all`}
                                checked={isFullySelected}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    selectAllForResource(resource);
                                  } else {
                                    deselectAllForResource(resource);
                                  }
                                }}
                                className={
                                  isPartiallySelected ? "opacity-50" : ""
                                }
                              />
                              <Label
                                htmlFor={`${resource}-all`}
                                className="font-medium cursor-pointer"
                              >
                                {resourceLabels[resource] || resource}
                              </Label>
                              {isPartiallySelected && (
                                <span className="text-xs text-muted-foreground">
                                  (Partial)
                                </span>
                              )}
                            </div>
                            {selectedActions.length > 0 && (
                              <span className="text-xs text-muted-foreground">
                                {selectedActions.length}/
                                {availableActions.length}
                              </span>
                            )}
                          </div>

                          <Separator className="my-2" />

                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {availableActions.map((action) => {
                              const isSelected =
                                selectedActions.includes(action);

                              return (
                                <div
                                  key={action}
                                  className="flex items-center gap-2"
                                >
                                  <Checkbox
                                    id={`${resource}-${action}`}
                                    checked={isSelected}
                                    onCheckedChange={() => {
                                      toggleAction(resource, action);
                                    }}
                                  />
                                  <Label
                                    htmlFor={`${resource}-${action}`}
                                    className="text-sm cursor-pointer"
                                  >
                                    {actionLabels[action]}
                                    {isSelected && (
                                      <Check className="ml-1 inline h-3 w-3" />
                                    )}
                                  </Label>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
