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

interface NotionConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function NotionConfigFields({
  form,
  prefix = "config",
}: NotionConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.databaseIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Database IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="e50e96..."
                {...field}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of Notion Database IDs to sync. Leave empty to sync all accessible databases.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.pageIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Page IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="b78a1c..."
                {...field}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of Notion Page IDs to sync. Leave empty to sync all accessible pages.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.batchSize`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Batch Size</FormLabel>
            <FormControl>
              <Input
                type="number"
                placeholder="100"
                {...field}
                onChange={(e) => {
                  const { value } = e.target;
                  if (value === "") {
                    field.onChange(undefined);
                    return;
                  }
                  const parsed = Number(value);
                  field.onChange(Number.isNaN(parsed) ? undefined : parsed);
                }}
              />
            </FormControl>
            <FormDescription>
              Number of pages/databases to process per batch (default: 100).
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
