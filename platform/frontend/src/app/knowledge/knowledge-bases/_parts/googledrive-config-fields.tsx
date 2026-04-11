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

interface GoogleDriveConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function GoogleDriveConfigFields({
  form,
  prefix = "config",
}: GoogleDriveConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.sharedDriveIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Shared Drive IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="0ABCxyz123, 0DEFabc456"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of shared (Team) Drive IDs to sync. Leave
              blank to sync only My Drive.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.folderId`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Folder ID (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Restrict sync to files within a specific folder. Use the folder ID
              from the Google Drive URL.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
