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
            <FormLabel>Shared Drive ID (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="0AFxxxxxxxxxxxxxxxxx"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              ID of a Shared Drive to sync. Leave blank to sync My Drive.
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
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Restrict sync to files inside this folder. Find the ID in the
              folder&apos;s URL.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.mimeTypes`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>MIME types (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="application/vnd.google-apps.document, text/plain"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of MIME types to sync. Leave blank to sync
              Google Docs, Sheets, Slides, and common text files.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
