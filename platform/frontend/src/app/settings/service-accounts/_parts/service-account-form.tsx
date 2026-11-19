"use client";

import type { Ref } from "react";
import type { UseFormReturn } from "react-hook-form";
import { AdvancedSection } from "@/components/advanced-section";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { IdentityFields } from "@/components/identity-fields";
import { RoleAssignmentBlockedNotice } from "@/components/role-assignment-blocked-notice";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { FieldDescription } from "@/components/ui/field-description";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleSelect } from "@/components/ui/role-select";
import { Textarea } from "@/components/ui/textarea";
import { formatRoleName } from "@/lib/utils/role";
import { ServiceAccountTeamSelect } from "./service-account-team-select";

export type ServiceAccountFormValues = {
  name: string;
  description: string;
  icon: string | null;
  role: string;
  teamId: string | null;
  labels: ProfileLabel[];
};

export const DEFAULT_SERVICE_ACCOUNT_FORM_VALUES: ServiceAccountFormValues = {
  name: "",
  description: "",
  icon: null,
  role: "member",
  teamId: null,
  labels: [],
};

/**
 * The edit page's form, as one section: who the account is, what it may do,
 * and, under Advanced, its labels. Creating an account is a dialog;
 * credentials are managed on the account's own page.
 */
export function ServiceAccountFormSections({
  form,
  labelsRef,
  error,
  onRoleChange,
}: {
  form: UseFormReturn<ServiceAccountFormValues>;
  labelsRef: Ref<ProfileLabelsRef>;
  /** The save mutation's error, for the refused-role notice. */
  error: unknown;
  onRoleChange?: () => void;
}) {
  const role = form.watch("role");
  const labels = form.watch("labels");
  return (
    <SettingsSectionGroup>
      <SettingsSection
        title="Identity and access"
        description="How the account appears in lists and logs, and what it can do."
      >
        <FormField
          control={form.control}
          name="name"
          rules={{
            validate: (value) => value.trim().length > 0 || "Name is required",
          }}
          render={({ field }) => (
            <FormItem>
              <IdentityFields
                icon={form.watch("icon")}
                onIconChange={(icon) =>
                  form.setValue("icon", icon, { shouldDirty: true })
                }
                showLogos
                label={<FormLabel>Display name</FormLabel>}
              >
                <FormControl>
                  <Input placeholder="Automation service account" {...field} />
                </FormControl>
                <FormMessage />
              </IdentityFields>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Description{" "}
                <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Textarea
                  placeholder="What this account is for, and who runs it"
                  rows={2}
                  maxLength={1000}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="space-y-2">
          <Label htmlFor="service-account-role">Roles</Label>
          <RoleSelect
            multiple
            id="service-account-role"
            value={role}
            onValueChange={(value) => {
              form.setValue("role", value, { shouldDirty: true });
              onRoleChange?.();
            }}
            placeholder="Select a role"
            className="w-full"
          />
          <FieldDescription>
            Roles decide what the account can do.
          </FieldDescription>
        </div>
        <RoleAssignmentBlockedNotice
          error={error}
          name={formatRoleName(role)}
        />
        <ServiceAccountTeamSelect
          id="service-account-team"
          value={form.watch("teamId")}
          onChange={(teamId) =>
            form.setValue("teamId", teamId, { shouldDirty: true })
          }
        />
        {/* Labels only organize the list, so they wait under Advanced unless
            set, as on the plugin form. */}
        <AdvancedSection keepMounted defaultOpen={labels.length > 0}>
          <ProfileLabels
            ref={labelsRef}
            labels={labels}
            onLabelsChange={(next) =>
              form.setValue("labels", next, { shouldDirty: true })
            }
          />
        </AdvancedSection>
      </SettingsSection>
    </SettingsSectionGroup>
  );
}
