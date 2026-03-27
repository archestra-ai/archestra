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
  hideUrl?: boolean;
}

export function NotionConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
}: NotionConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {!hideUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.notionApiUrl`}
          rules={{ required: "Notion API URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notion API URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://api.notion.com"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                The Notion API endpoint URL.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.databaseIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Database IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="abc123, def456"
                {...field}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of Notion database IDs to sync.
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
                placeholder="page-id-1, page-id-2"
                {...field}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of specific Notion page IDs to sync.
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
                placeholder="50"
                {...field}
                onChange={(e) => field.onChange(Number(e.target.value) || 50)}
              />
            </FormControl>
            <FormDescription>
              Number of pages to process per batch (default: 50).
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
