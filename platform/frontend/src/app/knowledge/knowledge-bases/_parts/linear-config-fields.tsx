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

interface LinearConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function LinearConfigFields({
  form,
  prefix = "config",
}: LinearConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.teamIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Team IDs (optional)</FormLabel>
            <FormControl>
              <Input placeholder="team_123, team_456" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated Linear team IDs to include.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.projectIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Project IDs (optional)</FormLabel>
            <FormControl>
              <Input placeholder="project_123, project_456" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated Linear project IDs to include.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.states`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Issue States (optional)</FormLabel>
            <FormControl>
              <Input placeholder="Todo, In Progress, Done" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated issue state names to sync.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.includeComments`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Comments</FormLabel>
              <FormDescription>
                Sync issue comment threads into document content.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={(field.value as boolean | undefined) ?? true}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.includeProjects`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Projects</FormLabel>
              <FormDescription>
                Sync projects and project updates as documents.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={(field.value as boolean | undefined) ?? false}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.includeCycles`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Cycles</FormLabel>
              <FormDescription>
                Sync cycles as separate documents.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={(field.value as boolean | undefined) ?? false}
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
            <FormLabel>Batch Size (optional)</FormLabel>
            <FormControl>
              <Input placeholder="50" {...field} />
            </FormControl>
            <FormDescription>
              Max items fetched per request. Leave empty for default.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
