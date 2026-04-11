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
        name={`${prefix}.driveId`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Drive ID (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="0ABCdef123..."
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              ID of the specific Shared Drive to sync. Leave blank to sync My Drive.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.folderPath`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Folder Path (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="/Knowledge Base/Docs"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Sync only files within this specific folder path.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.fileTypes`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>File Types (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="application/pdf, text/markdown"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of MIME types to include. Defaults to Google Docs and Markdown.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
