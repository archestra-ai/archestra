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

interface AsanaConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideWorkspaceGid?: boolean;
}

export function AsanaConfigFields({
  form,
  prefix = "config",
  hideWorkspaceGid = false,
}: AsanaConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <p className="text-[0.8rem] text-muted-foreground">
        Syncs tasks from the selected projects and their user comments. The
        connector does not separately traverse subtasks.
      </p>
      {!hideWorkspaceGid && (
        <FormField
          control={form.control}
          name={`${prefix}.workspaceGid`}
          rules={{ required: "Workspace GID is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Workspace GID</FormLabel>
              <FormControl>
                <Input
                  placeholder="1234567890"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>
                Your Asana workspace GID. Find it in the URL when viewing your
                workspace in Asana.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.projectGids`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Project GIDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="1234567890, 9876543210"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of project GIDs to sync. Leave blank to sync
              all projects in the workspace.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.tagsToSkip`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Tags to Skip (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="internal, draft"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of tag names to exclude.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
