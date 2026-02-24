"use client";

import {
  type Action,
  type Permissions,
  type Resource,
  resourceLabels,
} from "@shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllPermissions } from "@/lib/auth.query";
import {
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

const resourceCategories: Record<string, Resource[]> = {
  "Core Resources": [
    "agent",
    "mcpGateway",
    "llmProxy",
    "tool",
    "policy",
    "interaction",
    "conversation",
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
    "llmModels",
    "chatSettings",
    "identityProvider",
  ],
};

const actionLabels: Record<Action, string> = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Delete",
  admin: "Admin",
  cancel: "Cancel",
};

export function RolePermissionsCard() {
  const { data: activeOrg } = useActiveOrganization();
  const { data: role, isLoading: isRoleLoading } = useActiveMemberRole(
    activeOrg?.id,
  );
  const { data: permissions, isLoading: isPermissionsLoading } =
    useAllPermissions();

  const isLoading = isRoleLoading || isPermissionsLoading;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your Role & Permissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your Role & Permissions</CardTitle>
        {role && (
          <Badge
            variant="secondary"
            className="capitalize text-base px-4 py-1.5"
          >
            {role}
          </Badge>
        )}
      </CardHeader>
      {permissions && (
        <CardContent>
          <PermissionsGrid permissions={permissions} />
        </CardContent>
      )}
    </Card>
  );
}

function PermissionsGrid({ permissions }: { permissions: Permissions }) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(),
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

  return (
    <div className="space-y-2">
      {Object.entries(resourceCategories).map(([category, resources]) => {
        const visibleResources = resources.filter(
          (resource) =>
            permissions[resource] && permissions[resource].length > 0,
        );

        if (visibleResources.length === 0) return null;

        return (
          <CategorySection
            key={category}
            category={category}
            resources={visibleResources}
            permissions={permissions}
            isExpanded={expandedCategories.has(category)}
            onToggle={toggleCategory}
          />
        );
      })}
    </div>
  );
}

function CategorySection({
  category,
  resources,
  permissions,
  isExpanded,
  onToggle,
}: {
  category: string;
  resources: Resource[];
  permissions: Permissions;
  isExpanded: boolean;
  onToggle: (category: string) => void;
}) {
  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle(category)}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md border bg-card p-3 hover:bg-accent/50 transition-colors">
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        <span className="font-semibold text-sm">{category}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {resources.length} resource{resources.length !== 1 ? "s" : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1 pl-6">
          {resources.map((resource) => {
            const actions = permissions[resource] || [];
            return (
              <div
                key={resource}
                className="flex items-center gap-2 rounded-md border bg-card p-2"
              >
                <span className="text-sm font-medium min-w-[140px]">
                  {resourceLabels[resource] || resource}
                </span>
                <div className="flex flex-wrap gap-1">
                  {actions.map((action) => (
                    <Badge key={action} variant="outline" className="text-xs">
                      {actionLabels[action] || action}
                    </Badge>
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
