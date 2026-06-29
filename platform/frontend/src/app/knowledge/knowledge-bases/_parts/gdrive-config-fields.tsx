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
        name={`${prefix}.driveIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Drive IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="0ABcDeFgHiJkLmN, 0OpQrStUvWxYz"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of shared drive IDs to sync. Providing Drive
              IDs automatically enables shared-drive sync. Leave blank to sync
              files from My Drive.
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
                placeholder="1AbCdEfGhIjKlMnOpQrStUv"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Restrict sync to a specific folder. Find the folder ID in the
              Google Drive URL.
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
                placeholder=".pdf, .docx, .md"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of file extensions to include. Leave blank to
              sync all supported file types.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.recursive`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Recursive Traversal</FormLabel>
              <FormDescription>
                Sync files from all nested subfolders (enabled by default).
                Without a Folder ID, all drive files are synced regardless.
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
    </div>
  );
}
