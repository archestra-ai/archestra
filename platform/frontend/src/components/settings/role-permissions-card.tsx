"use client";

import {
  type Action,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
} from "@archestra/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useUpdateAccountNameMutation } from "@/lib/auth/account.query";
import { useAllPermissions, useSession } from "@/lib/auth/auth.query";
import { useActiveMemberRole } from "@/lib/organization.query";

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
  execute: "Execute",
  "deploy-to-restricted": "Deploy to Restricted",
  manage: "Manage",
  "manage-deleted": "Manage Deleted",
  "read-all": "Read All Chats",
  "share-org": "Share Org-Wide",
  impersonate: "Impersonate",
};

export function RolePermissionsCard() {
  const { data: session, isPending: isSessionPending } = useSession();
  const hasActiveOrganization = !!session?.session?.activeOrganizationId;
  const { data: role, isPending: isRolePending } = useActiveMemberRole();
  const { data: permissions, isLoading: isPermissionsLoading } =
    useAllPermissions();

  // The role query stays pending forever for a user with no active
  // organization (it never enables), so its wait only counts when the session
  // says there is an organization to have a role in.
  const isLoading =
    isSessionPending ||
    (hasActiveOrganization && isRolePending) ||
    isPermissionsLoading;

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
      <CardContent className="space-y-8">
        <ProfileForm
          name={session?.user?.name ?? ""}
          email={session?.user?.email ?? ""}
          image={session?.user?.image ?? null}
          role={role ?? ""}
        />
        {permissions && (
          <>
            <Separator />
            <div>
              <h4 className="text-sm font-semibold mb-2">Your Permissions</h4>
              <PermissionsGrid permissions={permissions} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileForm({
  name,
  email,
  image,
  role,
}: {
  name: string;
  email: string;
  image: string | null;
  role: string;
}) {
  const updateName = useUpdateAccountNameMutation();
  const form = useForm<NameFormValues>({
    resolver: zodResolver(NameFormSchema),
    values: { name },
  });

  async function onSubmit(values: NameFormValues) {
    const updated = await updateName.mutateAsync(values.name.trim());
    if (updated) {
      // Re-baseline the form so the Update button goes back to disabled;
      // the session refetch behind `values` lands a moment later.
      form.reset({ name: values.name.trim() });
    }
  }

  const initials = (name || email).slice(0, 2).toUpperCase();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Avatar className="size-20">
          {image && <AvatarImage src={image} alt="" />}
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        <div className="space-y-1">
          <p className="text-sm font-medium">Avatar</p>
          <p className="text-sm text-muted-foreground">
            Shown next to you across the app. It comes from your identity
            provider and can&apos;t be changed here.
          </p>
        </div>
      </div>

      <Form {...form}>
        <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    autoComplete="name"
                    disabled={updateName.isPending}
                  />
                </FormControl>
                <FormDescription>
                  This is the name your teammates see on your chats, agents, and
                  audit records.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Email and role are read-only here: neither has a self-service
              endpoint. They stay real inputs so the section reads as one form
              and the values can still be selected and copied. */}
          <div className="space-y-2">
            <Label htmlFor="account-email">Email</Label>
            <Input
              id="account-email"
              value={email || "\u2014"}
              readOnly
              className="bg-muted text-muted-foreground"
            />
            <p className="text-sm text-muted-foreground">
              You sign in with this address. It can&apos;t be changed here.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="account-role">Role</Label>
            <Input
              id="account-role"
              value={role || "\u2014"}
              readOnly
              className="bg-muted capitalize text-muted-foreground"
            />
            <p className="text-sm text-muted-foreground">
              Your role decides what you can reach across the platform. Only an
              admin can change it.
            </p>
          </div>

          <Button
            type="submit"
            disabled={updateName.isPending || !form.formState.isDirty}
          >
            {updateName.isPending && (
              <Loader2 className="size-4 animate-spin" />
            )}
            <span>Update profile</span>
          </Button>
        </form>
      </Form>
    </div>
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
          {resources.length} resource
          {resources.length !== 1 ? <span>s</span> : null}
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
