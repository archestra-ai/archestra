// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { IdentityProviderFormValues } from "@archestra/shared";
import type { ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { IdentityProviderSectionHeader } from "./identity-provider-section-header.ee";
import { SsoTemplateDebugSection } from "./sso-template-debug-section.ee";

interface TeamSyncConfigFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
  identityProviderId?: string;
  embedded?: boolean;
  showEnabledField?: boolean;
  groupsExpressionReadOnly?: boolean;
  groupsExpressionDescription?: ReactNode;
}

export function TeamSyncConfigForm({
  form,
  identityProviderId,
  embedded = false,
  showEnabledField = true,
  groupsExpressionReadOnly = false,
  groupsExpressionDescription,
}: TeamSyncConfigFormProps) {
  const content = (
    <>
      <IdentityProviderSectionHeader title="Team Sync">
        Sync team membership from sign-in groups. Set each team’s external group
        IDs in External Group Sync.
      </IdentityProviderSectionHeader>
      {showEnabledField && (
        <FormField
          control={form.control}
          name="teamSyncConfig.enabled"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value !== false}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>Enable Team Sync</FormLabel>
                <FormDescription>
                  Add and remove team members automatically when they sign in.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name="teamSyncConfig.groupsExpression"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Groups Handlebars Template</FormLabel>
            <FormDescription>
              {groupsExpressionDescription ?? (
                <>
                  Extract group identifiers as a comma-separated list or JSON
                  array. Leave empty to use the groups claim.
                </>
              )}
            </FormDescription>
            <FormControl>
              <Input
                placeholder="{{#each roles}}{{this.name}},{{/each}}"
                className="font-mono text-sm"
                readOnly={groupsExpressionReadOnly}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <SsoTemplateDebugSection
        identityProviderId={identityProviderId}
        mode="team-sync"
        template={form.watch("teamSyncConfig.groupsExpression")}
        templateLabel="the team sync groups template"
        teamSyncEnabled={form.watch("teamSyncConfig.enabled") !== false}
      />
    </>
  );

  return <div className={embedded ? "space-y-4" : "space-y-6"}>{content}</div>;
}
