// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { Permissions } from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import { SettingsSection } from "@/components/settings-section";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PermissionList } from "./permission-list.ee";

/** What a role grants, as both the edit form and the role's page explain it. */
export const ROLE_PERMISSIONS_INTRO =
  "A role grants permissions for every object of a type, such as all agents. Access to one specific object is set on that object itself.";

export type RoleFormValues = {
  name: string;
  description: string;
  permission: Permissions;
};

/** The name and description of a role, as the create and edit pages ask. */
export function RoleIdentitySection({
  form,
  disabled,
}: {
  form: UseFormReturn<RoleFormValues>;
  disabled?: boolean;
}) {
  return (
    <SettingsSection
      title="Identity"
      description="Name and description shown to admins when assigning this role to users, teams, and invitations."
    >
      <FormField
        control={form.control}
        name="name"
        rules={{
          validate: (value) => value.trim().length > 0 || "Name is required",
        }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input
                placeholder="e.g. Developer"
                disabled={disabled}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Textarea
                placeholder="Who this role is for and what it lets them do"
                disabled={disabled}
                className="min-h-[60px]"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </SettingsSection>
  );
}

/**
 * The permissions a role grants, with the one sentence that keeps a role's
 * organization-wide grants apart from access to a particular object.
 */
export function RolePermissionsSection({
  form,
  grantable,
}: {
  form: UseFormReturn<RoleFormValues>;
  grantable: Permissions;
}) {
  return (
    <SettingsSection title="Permissions" description={ROLE_PERMISSIONS_INTRO}>
      <FormField
        control={form.control}
        name="permission"
        render={({ field }) => (
          <PermissionList
            permissions={field.value}
            onChange={field.onChange}
            grantable={grantable}
          />
        )}
      />
    </SettingsSection>
  );
}
