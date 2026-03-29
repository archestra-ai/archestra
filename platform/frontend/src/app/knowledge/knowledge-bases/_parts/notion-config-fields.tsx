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
                placeholder="database-id-1, database-id-2"
                {...field}
              />
            </FormControl>
            <FormDescription>
              Comma-separated Notion database IDs to sync. Leave blank to sync
              all accessible pages in the workspace.
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
              <Input placeholder="page-id-1, page-id-2" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated Notion page IDs to sync explicitly. Takes priority
              over Database IDs when both are provided.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
