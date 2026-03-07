"use client";

import {
  type Action,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
} from "@shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

const actionLabels: Record<Action, string> = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Delete",
  "team-admin": "Team Admin",
  admin: "Admin",
  cancel: "Cancel",
};

export function RolePermissionsCard() {
  const { data: session } = authClient.useSession();
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
        <CardContent className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <span className="text-muted-foreground">Username:</span>
          <span>{session?.user?.name || "—"}</span>
          <span className="text-muted-foreground">Email:</span>
          <span>{session?.user?.email || "—"}</span>
          <span className="text-muted-foreground">Role:</span>
          <span className="capitalize">{role || "—"}</span>
        </div>
        {permissions && (
          <>
            <Separator />
            <div>
              <h4 className="text-sm font-semibold mb-2">Permissions</h4>
              <PermissionsGrid permissions={permissions} />
            </div>
          </>
        )}
      </CardContent>
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
                className="flex items-center justify-between gap-4 rounded-md border bg-card px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-tight">
                    {resourceLabels[resource] || resource}
                  </p>
                  {resourceDescriptions[resource] && (
                    <p className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
                      {resourceDescriptions[resource]}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 shrink-0">
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
