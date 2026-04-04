"use client";

import {
  E2eTestId,
  getIdpRoleMappingRuleRowTestId,
  type IdentityProviderFormValues,
} from "@shared";
import { Info, Plus, Trash2 } from "lucide-react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppName } from "@/lib/hooks/use-app-name";

interface RoleMappingFormProps {
  form: UseFormReturn<IdentityProviderFormValues>;
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

export function RoleMappingForm({ form }: RoleMappingFormProps) {
  const appName = useAppName();
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "roleMapping.rules",
  });

  return (
    <div className="space-y-6">
      <Separator />

      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="role-mapping" className="border-none">
          <AccordionTrigger
            className="hover:no-underline"
            data-testid={E2eTestId.IdpRoleMappingAccordionTrigger}
          >
            <div className="flex items-center gap-2">
              <h4 className="text-md font-medium">Role Mapping (Optional)</h4>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    <p>
                      Map identity provider attributes to {appName} roles using
                      Handlebars templates. Rules are evaluated in order - first
                      match wins.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pt-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <FormLabel>Mapping Rules</FormLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append({ expression: "", role: "member" })}
                  data-testid={E2eTestId.IdpRoleMappingAddRule}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Add Rule
                </Button>
              </div>

              {fields.length > 1 && (
                <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded-md">
                  <span className="font-medium">Note:</span> Rules are evaluated
                  in order from top to bottom. The first matching rule
                  determines the user&apos;s role. Order your most specific
                  rules first.
                </p>
              )}

              {fields.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No mapping rules configured. All users will be assigned the
                  default role.
                </p>
              ) : (
                <div className="space-y-4">
                  {fields.map((field, index) => (
                    <div
                      key={field.id}
                      className="flex items-start gap-3 p-3 border rounded-md"
                      data-testid={getIdpRoleMappingRuleRowTestId(index)}
                    >
                      <div className="flex items-start gap-3 w-full flex-1 min-w-0">
                        <FormField
                          control={form.control}
                          name={`roleMapping.rules.${index}.expression`}
                          render={({ field }) => (
                            <FormItem className="flex-[3] min-w-0">
                              <FormLabel className="text-xs">
                                Handlebars Template
                              </FormLabel>
                              <FormControl>
                                <Input
                                  placeholder='{{#includes groups "admin"}}true{{/includes}}'
                                  className="font-mono text-sm"
                                  data-testid={
                                    E2eTestId.IdpRoleMappingRuleTemplate
                                  }
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
                                    data-testid={
                                      E2eTestId.IdpRoleMappingRuleRole
                                    }
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
                        onClick={() => remove(index)}
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
                      If enabled, denies user login when no role mapping rules
                      match. Without strict mode, users who don&apos;t match any
                      rule are assigned the default role.
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
                      Prevent synchronizing users&apos; roles on subsequent
                      logins. When enabled, the role is only set on first login,
                      allowing manual role management afterward.
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />

            <Accordion type="single" collapsible className="w-full">
              <AccordionItem
                value="examples"
                className="!border rounded-md bg-muted/30"
              >
                <AccordionTrigger className="px-4 py-2 hover:no-underline">
                  <span className="text-sm font-medium">Example Templates</span>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 pt-0">
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    {HANDLEBARS_EXAMPLES.map(({ expression, description }) => (
                      <li key={`${expression}-${description}`}>
                        <code className="text-xs bg-muted px-1 py-0.5 rounded break-all">
                          {expression}
                        </code>
                        <span className="ml-2">- {description}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground mt-3">
                    Templates should render to a non-empty string when the rule
                    matches. Available helpers: includes, equals, contains, and,
                    or, exists.
                  </p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
