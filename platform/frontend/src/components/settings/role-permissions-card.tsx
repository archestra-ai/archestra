"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Action,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
} from "@shared";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useUpdateAccountNameMutation } from "@/lib/auth/account.query";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

const NameFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
});

type NameFormValues = z.infer<typeof NameFormSchema>;

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
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <span className="flex h-8 items-center text-muted-foreground">
            Name:
          </span>
          <EditableName value={session?.user?.name ?? ""} />
          <span className="flex h-8 items-center text-muted-foreground">
            Email:
          </span>
          <span className="flex h-8 items-center">
            {session?.user?.email || "—"}
          </span>
          <span className="flex h-8 items-center text-muted-foreground">
            Role:
          </span>
          <span className="flex h-8 items-center capitalize">
            {role || "—"}
          </span>
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

function EditableName({ value }: { value: string }) {
  const [isEditing, setIsEditing] = useState(false);
  const updateName = useUpdateAccountNameMutation();
  const form = useForm<NameFormValues>({
    resolver: zodResolver(NameFormSchema),
    values: { name: value },
  });

  async function onSubmit(values: NameFormValues) {
    const updated = await updateName.mutateAsync(values.name.trim());
    if (updated) {
      setIsEditing(false);
    }
  }

  if (isEditing) {
    return (
      <Form {...form}>
        <form
          className="flex min-w-0 flex-wrap items-start gap-2"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="min-w-52 flex-1">
                <FormControl>
                  <Input
                    {...field}
                    autoFocus
                    autoComplete="name"
                    className="h-8"
                    disabled={updateName.isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            size="icon"
            className="h-8 w-8"
            disabled={updateName.isPending}
            aria-label="Save name"
          >
            {updateName.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={updateName.isPending}
            onClick={() => {
              form.reset({ name: value });
              setIsEditing(false);
            }}
            aria-label="Cancel name edit"
          >
            <X className="h-4 w-4" />
          </Button>
        </form>
      </Form>
    );
  }

  return (
    <span className="flex h-8 min-w-0 items-center gap-2">
      <span className="truncate">{value || "—"}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => setIsEditing(true)}
        aria-label="Edit name"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    </span>
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
