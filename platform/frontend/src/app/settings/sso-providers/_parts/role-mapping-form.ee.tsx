"use client";

import { E2eTestId, type SsoProviderFormValues } from "@shared";
import { Info, Plus, Trash2 } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRoles } from "@/lib/role.query";

interface RoleMappingFormProps {
  form: UseFormReturn<SsoProviderFormValues>;
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
  const rules = form.watch("roleMapping.rules") || [];
  const accordionContentRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  // Track rule IDs for stable keys. Generate initial IDs based on current rule count.
  const [ruleIds, setRuleIds] = useState<string[]>(() =>
    rules.map((_, i) => `${baseId}-rule-${i}`),
  );
  // Fetch all roles (predefined + custom)
  const { data: roles = [] } = useRoles();

  // Scroll the accordion content into view when expanded
  const handleAccordionChange = useCallback((value: string) => {
    if (value === "role-mapping") {
      // Small delay to allow accordion animation to start
      setTimeout(() => {
        accordionContentRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 100);
    }
  }, []);

  const addRule = useCallback(() => {
    const currentRules = form.getValues("roleMapping.rules") || [];
    const newId = `${baseId}-rule-${Date.now()}`;
    setRuleIds((prev) => [...prev, newId]);
    form.setValue("roleMapping.rules", [
      ...currentRules,
      { expression: "", role: "member" },
    ]);
  }, [form, baseId]);

  const removeRule = useCallback(
    (index: number) => {
      const currentRules = form.getValues("roleMapping.rules") || [];
      setRuleIds((prev) => prev.filter((_, i) => i !== index));
      form.setValue(
        "roleMapping.rules",
        currentRules.filter((_, i) => i !== index),
      );
    },
    [form],
  );

  return (
    <div className="space-y-6">
      <Separator />

      <Accordion
        type="single"
        collapsible
        className="w-full"
        onValueChange={handleAccordionChange}
      >
        <AccordionItem value="role-mapping" className="border-none">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <h4 className="text-md font-medium">Role Mapping (Optional)</h4>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    <p>
                      Map SSO provider attributes to Archestra roles using
                      Handlebars templates. Rules are evaluated in order - first
                      match wins.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </AccordionTrigger>
          <AccordionContent
            ref={accordionContentRef}
            className="space-y-4 pt-4"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <FormLabel>Mapping Rules</FormLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addRule}
                  data-testid={E2eTestId.SsoRoleMappingAddRule}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Add Rule
                </Button>
              </div>

              {rules.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No mapping rules configured. All users will be assigned the
                  default role.
                </p>
              ) : (
                <div className="space-y-4">
                  {rules.map((_, index) => (
                    <div
                      key={ruleIds[index] || `fallback-${index}`}
                      className="flex gap-3 items-start p-3 border rounded-md"
                    >
                      <div className="flex-1 space-y-3">
                        <FormField
                          control={form.control}
                          name={`roleMapping.rules.${index}.expression`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">
                                Handlebars Template
                              </FormLabel>
                              <FormControl>
                                <Input
                                  placeholder='{{#includes groups "admin"}}true{{/includes}}'
                                  className="font-mono text-sm"
                                  data-testid={
                                    E2eTestId.SsoRoleMappingRuleTemplate
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
                            <FormItem>
                              <FormLabel className="text-xs">
                                Archestra Role
                              </FormLabel>
                              <Select
                                onValueChange={field.onChange}
                                value={field.value}
                              >
                                <FormControl>
                                  <SelectTrigger
                                    data-testid={
                                      E2eTestId.SsoRoleMappingRuleRole
                                    }
                                  >
                                    <SelectValue placeholder="Select role" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {roles.map((role) => (
                                    <SelectItem key={role.id} value={role.role}>
                                      {role.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
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
                        className="text-destructive hover:text-destructive"
                        onClick={() => removeRule(index)}
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
                        data-testid={E2eTestId.SsoRoleMappingDefaultRole}
                      >
                        <SelectValue placeholder="Select default role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {roles.map((role) => (
                        <SelectItem key={role.id} value={role.role}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
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
