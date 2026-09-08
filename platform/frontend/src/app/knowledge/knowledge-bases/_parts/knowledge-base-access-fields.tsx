// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { Globe, User, Users } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import {
  TeamVisibilityPicker,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useTeams } from "@/lib/teams/team.query";

export interface KnowledgeBaseFormValues {
  name: string;
  description: string;
  visibility: "org-wide" | "team-scoped" | "private";
  teamIds: string[];
}

export function KnowledgeBaseAccessFields({
  form,
}: {
  form: UseFormReturn<KnowledgeBaseFormValues>;
}) {
  const { data: teams } = useTeams();
  const enabled = useEnterpriseFeature("knowledgeBase");
  const visibility = form.watch("visibility");
  return (
    <div className="space-y-2">
      <FormField
        control={form.control}
        name="visibility"
        render={({ field }) => (
          <FormItem>
            <VisibilitySelector
              label="Sharing"
              description="Document permissions still apply. Sharing this knowledge base does not change source permissions."
              value={field.value}
              onValueChange={field.onChange}
              options={[
                {
                  value: "private",
                  label: "Personal",
                  description: "Only you can access this knowledge base",
                  icon: User,
                },
                {
                  value: "org-wide",
                  label: "Organization",
                  description:
                    "Anyone in your organization can access this knowledge base",
                  icon: Globe,
                },
                {
                  value: "team-scoped",
                  label: "Teams",
                  description: "Share this knowledge base with selected teams",
                  icon: Users,
                  disabled: !enabled && visibility !== "team-scoped",
                  disabledLabel: !enabled ? "Enterprise feature" : undefined,
                },
              ]}
            >
              {visibility === "team-scoped" && (
                <FormField
                  control={form.control}
                  name="teamIds"
                  rules={{
                    validate: (ids) =>
                      ids.length > 0 || "Select at least one team",
                  }}
                  render={({ field: teamField }) => (
                    <FormItem>
                      <TeamVisibilityPicker
                        teams={teams ?? []}
                        value={teamField.value}
                        onChange={teamField.onChange}
                        required
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </VisibilitySelector>
          </FormItem>
        )}
      />
    </div>
  );
}
