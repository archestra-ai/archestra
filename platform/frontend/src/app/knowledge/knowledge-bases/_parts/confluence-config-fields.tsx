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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface ConfluenceConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
  hideIsCloud?: boolean;
}

export function ConfluenceConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
  hideIsCloud = false,
}: ConfluenceConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {!hideUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.confluenceUrl`}
          rules={{ required: "URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://your-domain.atlassian.net/wiki"
                  {...field}
                />
              </FormControl>
              <FormDescription>Your Confluence instance URL.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {!hideIsCloud && (
        <FormField
          control={form.control}
          name={`${prefix}.isCloud`}
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Cloud Instance</FormLabel>
                <FormDescription>
                  Enable if this is a Confluence Cloud instance.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value ?? true}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.spaceKeys`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Space Keys (optional)</FormLabel>
            <FormControl>
              <Input placeholder="ENG, DOCS, TEAM" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of space keys to sync.
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
              <Input placeholder="12345, 67890" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of specific page IDs to sync.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.cqlQuery`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>CQL Query (optional)</FormLabel>
            <FormControl>
              <Textarea
                placeholder='space = "ENG" AND type = "page"'
                rows={3}
                {...field}
              />
            </FormControl>
            <FormDescription>Custom CQL to filter content.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.labelsToSkip`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Labels to Skip (optional)</FormLabel>
            <FormControl>
              <Input placeholder="draft, archive" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of labels to exclude.
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
