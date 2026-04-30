"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

interface SalesforceConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function SalesforceConfigFields({
  form,
  prefix = "config",
}: SalesforceConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.objects`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Objects (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="Account, Contact, Opportunity, Case"
                {...field}
              />
            </FormControl>
            <FormDescription>
              Comma-separated Salesforce object names. Leave empty to default to
              <code> Account, Contact, Opportunity, Case</code>.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.advancedObjectConfigJson`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Advanced Object Config JSON (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder='{"Account":{"fields":["Id","Name"],"associations":{"Contact":["Id","Email"]}}}'
                {...field}
              />
            </FormControl>
            <FormDescription>
              Optional JSON object for precise field/association indexing. When
              provided, this overrides simple object selection.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
