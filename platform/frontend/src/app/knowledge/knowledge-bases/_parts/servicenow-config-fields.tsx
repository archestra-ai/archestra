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

interface ServiceNowConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
}

export function ServiceNowConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
}: ServiceNowConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {!hideUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.instanceUrl`}
          rules={{ required: "Instance URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Instance URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://your-instance.service-now.com"
                  {...field}
                />
              </FormControl>
              <FormDescription>Your ServiceNow instance URL.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.knowledgeBases`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Knowledge Bases (optional)</FormLabel>
            <FormControl>
              <Input placeholder="sys_id_1, sys_id_2" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of knowledge base sys_ids to sync.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.categories`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Categories (optional)</FormLabel>
            <FormControl>
              <Input placeholder="sys_id_1, sys_id_2" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of category sys_ids to filter by.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.query`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Encoded Query (optional)</FormLabel>
            <FormControl>
              <Textarea
                placeholder="short_descriptionLIKEnetwork^workflow_state=published"
                rows={3}
                {...field}
              />
            </FormControl>
            <FormDescription>
              Custom ServiceNow encoded query to filter articles.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.includeRetired`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Retired Articles</FormLabel>
              <FormDescription>
                When enabled, retired articles will also be synced.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value ?? false}
                onCheckedChange={field.onChange}
              />
            </FormControl>
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
              Number of articles to process per batch (default: 50).
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
