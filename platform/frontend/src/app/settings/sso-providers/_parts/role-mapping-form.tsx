"use client";

import type { SsoProviderFormValues } from "@shared";
import { Info, Plus, Trash2 } from "lucide-react";
import { useCallback } from "react";
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

interface RoleMappingFormProps {
  form: UseFormReturn<SsoProviderFormValues>;
}

const JMESPATH_EXAMPLES = [
  {
    expression: "contains(groups || `[]`, 'admin')",
    description: "Match if 'admin' is in the groups array",
  },
  {
    expression: "role == 'administrator'",
    description: "Match if role claim equals 'administrator'",
  },
  {
    expression: "roles[?@ == 'archestra-admin'] | [0]",
    description: "Match if 'archestra-admin' is in roles array",
  },
  {
    expression: "department == 'IT' && title != null",
    description: "Match IT department users with a title",
  },
];

export function RoleMappingForm({ form }: RoleMappingFormProps) {
  const rules = form.watch("roleMapping.rules") || [];

  const addRule = useCallback(() => {
    const currentRules = form.getValues("roleMapping.rules") || [];
    form.setValue("roleMapping.rules", [
      ...currentRules,
      { expression: "", role: "member" },
    ]);
  }, [form]);

  const removeRule = useCallback(
    (index: number) => {
      const currentRules = form.getValues("roleMapping.rules") || [];
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

      <Accordion type="single" collapsible className="w-full">
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
                      JMESPath expressions. Rules are evaluated in order - first
                      match wins.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="roleMapping.dataSource"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Data Source</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || "combined"}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select data source" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="combined">
                        Combined (Token + UserInfo)
                      </SelectItem>
                      <SelectItem value="userInfo">UserInfo Only</SelectItem>
                      <SelectItem value="token">ID Token Only</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Choose which SSO data to use for role mapping expressions.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <FormLabel>Mapping Rules</FormLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addRule}
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
                  {rules.map(({ expression, role }, index) => (
                    <div
                      key={`${expression}-${role}`}
                      className="flex gap-3 items-start p-3 border rounded-md"
                    >
                      <div className="flex-1 space-y-3">
                        <FormField
                          control={form.control}
                          name={`roleMapping.rules.${index}.expression`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">
                                JMESPath Expression
                              </FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="contains(groups || `[]`, 'admin')"
                                  className="font-mono text-sm"
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
                                  <SelectTrigger>
                                    <SelectValue placeholder="Select role" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="admin">Admin</SelectItem>
                                  <SelectItem value="member">Member</SelectItem>
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
                      <SelectTrigger>
                        <SelectValue placeholder="Select default role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
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

            <div className="rounded-md bg-muted p-4">
              <p className="text-sm font-medium mb-2">Example Expressions</p>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {JMESPATH_EXAMPLES.map(({ expression, description }) => (
                  <li key={`${expression}-${description}`}>
                    <code className="text-xs bg-background px-1 py-0.5 rounded">
                      {expression}
                    </code>
                    <span className="ml-2">- {description}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground mt-3">
                <a
                  href="https://jmespath.org/tutorial.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Learn more about JMESPath syntax
                </a>
              </p>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
