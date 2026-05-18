"use client";

import type { IdentityProviderFormValues } from "@shared";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { getIdentityProviderClaimHint } from "./identity-provider-claim-hints";
import { SsoTemplateDebugSection } from "./sso-template-debug-section.ee";

interface TeamSyncConfigFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
  identityProviderId?: string;
  embedded?: boolean;
}

const HANDLEBARS_EXAMPLES = [
  {
    expression: "{{#each groups}}{{this}},{{/each}}",
    description: 'Simple flat array: ["admin", "users"]',
  },
  {
    expression: "{{#each roles}}{{this.name}},{{/each}}",
    description: 'Extract names from objects: [{name: "admin"}]',
  },
  {
    expression: '{{{json (pluck roles "name")}}}',
    description: "Extract names as JSON array using pluck helper",
  },
];

export function TeamSyncConfigForm({
  form,
  identityProviderId,
  embedded = false,
}: TeamSyncConfigFormProps) {
  const appName = useAppName();
  const providerClaimHint = getIdentityProviderClaimHint(
    form.watch("providerId"),
  );
  const content = (
    <>
      {providerClaimHint && (
        <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
          {providerClaimHint.teamSyncNote}
        </p>
      )}

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
                When enabled, users are automatically added/removed from
                {` `}
                {appName} teams based on their SSO group memberships.
              </FormDescription>
            </div>
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="teamSyncConfig.groupsExpression"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Groups Handlebars Template</FormLabel>
            <FormControl>
              <Input
                placeholder="{{#each roles}}{{this.name}},{{/each}}"
                className="font-mono text-sm"
                {...field}
              />
            </FormControl>
            <FormDescription>
              Handlebars template to extract group identifiers from SSO claims.
              Should render to a comma-separated list or JSON array. Leave empty
              to use default extraction.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <SsoTemplateDebugSection
        identityProviderId={identityProviderId}
        mode="team-sync"
        template={form.watch("teamSyncConfig.groupsExpression")}
        templateLabel="the team sync groups template"
        examples={HANDLEBARS_EXAMPLES}
      />
    </>
  );

  return <div className={embedded ? "space-y-4" : "space-y-6"}>{content}</div>;
}
