"use client";

import type { SsoProviderFormValues } from "@shared";
import { Info } from "lucide-react";
import { useCallback, useRef } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TeamSyncConfigFormProps {
  form: UseFormReturn<SsoProviderFormValues>;
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

export function TeamSyncConfigForm({ form }: TeamSyncConfigFormProps) {
  const accordionContentRef = useRef<HTMLDivElement>(null);

  // Scroll the accordion content into view when expanded
  const handleAccordionChange = useCallback((value: string) => {
    if (value === "team-sync") {
      // Small delay to allow accordion animation to start
      setTimeout(() => {
        accordionContentRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 100);
    }
  }, []);

  return (
    <div className="space-y-6">
      <Separator />

      <Accordion
        type="single"
        collapsible
        className="w-full"
        onValueChange={handleAccordionChange}
      >
        <AccordionItem value="team-sync" className="border-none">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-2">
              <h4 className="text-md font-medium">
                Team Sync Configuration (Optional)
              </h4>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm">
                    <p>
                      Configure how group identifiers are extracted from SSO
                      tokens for automatic team membership synchronization.
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
                      Archestra teams based on their SSO group memberships.
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
                    Handlebars template to extract group identifiers from SSO
                    claims. Should render to a comma-separated list or JSON
                    array. Leave empty to use default extraction.
                  </FormDescription>
                  <FormMessage />
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
                    Use this to extract group names from complex token
                    structures. For example, if your IdP sends{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      roles: [{"{"}name: &quot;admin&quot;{"}"}]
                    </code>
                    , use{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      {"{{#each roles}}{{this.name}},{{/each}}"}
                    </code>
                    .
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
