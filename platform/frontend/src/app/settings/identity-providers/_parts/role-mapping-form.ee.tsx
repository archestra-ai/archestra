"use client";

import {
  E2eTestId,
  getIdpRoleMappingRuleRowTestId,
  type IdentityProviderFormValues,
} from "@shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { RoleSelectContent } from "@/components/ui/role-select";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";
import { getIdentityProviderClaimHint } from "./identity-provider-claim-hints";
import { SsoTemplateDebugSection } from "./sso-template-debug-section.ee";

interface RoleMappingFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
  identityProviderId?: string;
  embedded?: boolean;
}

const HANDLEBARS_EXAMPLES = [
  {
    expression: '{{#includes groups "admin"}}true{{/includes}}',
    description: "Match if 'admin' is in the groups array",
  },
  {
    expression: '{{#equals role "administrator"}}true{{/equals}}',
    description: "Match if role claim equals 'administrator'",
  },
  {
    expression:
      '{{#each roles}}{{#equals this "archestra-admin"}}true{{/equals}}{{/each}}',
    description: "Match if 'archestra-admin' is in roles array",
  },
  {
    expression:
      '{{#and department title}}{{#equals department "IT"}}true{{/equals}}{{/and}}',
    description: "Match IT department users with a title",
  },
];

export function RoleMappingForm({
  form,
  identityProviderId,
  embedded = false,
}: RoleMappingFormProps) {
  const appName = useAppName();
  const providerClaimHint = getIdentityProviderClaimHint(
    form.watch("providerId"),
  );
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "roleMapping.rules",
  });
  const [selectedRuleIndex, setSelectedRuleIndex] = useState(0);
  const roleMappingRules = form.watch("roleMapping.rules") ?? [];
  const activeRuleIndex =
    fields.length > 0 ? Math.min(selectedRuleIndex, fields.length - 1) : null;
  const activeRule =
    activeRuleIndex === null ? null : roleMappingRules[activeRuleIndex];
  const activeRuleLabel =
    activeRuleIndex === null
      ? "the selected role mapping rule"
      : `role mapping rule ${activeRuleIndex + 1}${activeRule?.role ? ` (${activeRule.role})` : ""}`;

  const content = (
    <>
      {providerClaimHint && (
        <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
          {providerClaimHint.roleMappingNote}
        </p>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <FormLabel>Mapping Rules</FormLabel>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              append({ expression: "", role: "member" });
              setSelectedRuleIndex(fields.length);
            }}
            data-testid={E2eTestId.IdpRoleMappingAddRule}
          >
            <Plus className="mr-1 h-4 w-4" />
            Add Rule
          </Button>
        </div>

        {fields.length > 1 && (
          <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md">
            <span className="font-medium">Note:</span>
            {` `}Rules are evaluated in order from top to bottom. The first
            matching rule determines the user&apos;s role. Order your most
            specific rules first.
          </p>
        )}

        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mapping rules configured. All users will be assigned the default
            role.
          </p>
        ) : (
          <div className="space-y-4">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className={cn(
                  "flex items-start gap-3 p-3 border rounded-md transition-colors",
                  activeRuleIndex === index && "border-primary/50 bg-muted/20",
                )}
                data-testid={getIdpRoleMappingRuleRowTestId(index)}
                onFocusCapture={() => setSelectedRuleIndex(index)}
              >
                <div className="flex items-start gap-3 w-full flex-1 min-w-0">
                  <FormField
                    control={form.control}
                    name={`roleMapping.rules.${index}.expression`}
                    render={({ field }) => (
                      <FormItem className="flex-[3] min-w-0">
                        <div className="flex min-h-5 items-center gap-2">
                          <FormLabel className="text-xs">
                            Handlebars Template
                          </FormLabel>
                          {activeRuleIndex === index && (
                            <Badge variant="outline" className="px-1.5 py-0">
                              Tested below
                            </Badge>
                          )}
                        </div>
                        <FormControl>
                          <Input
                            placeholder='{{#includes groups "admin"}}true{{/includes}}'
                            className="font-mono text-sm"
                            data-testid={E2eTestId.IdpRoleMappingRuleTemplate}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`roleMapping.rules.${index}.role`}
                    render={({ field }) => (
                      <FormItem className="flex-1 min-w-[220px] max-w-[360px]">
                        <FormLabel className="text-xs">
                          {appName} Role
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger
                              data-testid={E2eTestId.IdpRoleMappingRuleRole}
                            >
                              <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                          </FormControl>
                          <RoleSelectContent />
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 mt-6 text-destructive hover:text-destructive"
                  onClick={() => {
                    setSelectedRuleIndex((currentIndex) => {
                      if (currentIndex <= index) return currentIndex;
                      return currentIndex - 1;
                    });
                    remove(index);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <FormField
        control={form.control}
        name="roleMapping.defaultRole"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Default Role</FormLabel>
            <Select
              onValueChange={field.onChange}
              value={field.value || "member"}
            >
              <FormControl>
                <SelectTrigger
                  data-testid={E2eTestId.IdpRoleMappingDefaultRole}
                >
                  <SelectValue placeholder="Select default role" />
                </SelectTrigger>
              </FormControl>
              <RoleSelectContent />
            </Select>
            <FormDescription>
              Role assigned when no mapping rules match.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <Separator className="my-4" />

      <FormField
        control={form.control}
        name="roleMapping.strictMode"
        render={({ field }) => (
          <FormItem className="flex flex-row items-start space-x-3 space-y-0">
            <FormControl>
              <Checkbox
                checked={field.value || false}
                onCheckedChange={field.onChange}
              />
            </FormControl>
            <div className="space-y-1 leading-none">
              <FormLabel>Strict Mode</FormLabel>
              <FormDescription>
                If enabled, denies user login when no role mapping rules match.
                Without strict mode, users who don&apos;t match any rule are
                assigned the default role.
              </FormDescription>
            </div>
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="roleMapping.skipRoleSync"
        render={({ field }) => (
          <FormItem className="flex flex-row items-start space-x-3 space-y-0">
            <FormControl>
              <Checkbox
                checked={field.value || false}
                onCheckedChange={field.onChange}
              />
            </FormControl>
            <div className="space-y-1 leading-none">
              <FormLabel>Skip Role Sync</FormLabel>
              <FormDescription>
                Prevent synchronizing users&apos; roles on subsequent logins.
                When enabled, the role is only set on first login, allowing
                manual role management afterward.
              </FormDescription>
            </div>
          </FormItem>
        )}
      />

      <SsoTemplateDebugSection
        identityProviderId={identityProviderId}
        mode="role"
        template={activeRule?.expression}
        templateLabel={activeRuleLabel}
        examples={HANDLEBARS_EXAMPLES}
      />
    </>
  );

  return <div className={embedded ? "space-y-4" : "space-y-6"}>{content}</div>;
}
