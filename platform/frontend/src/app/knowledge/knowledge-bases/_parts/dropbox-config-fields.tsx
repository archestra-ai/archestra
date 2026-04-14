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

interface DropboxConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function DropboxConfigFields({
  form,
  prefix = "config",
}: DropboxConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.folderPath`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Folder Path (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="/Projects/Docs"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Path to the Dropbox folder to sync. Must start with
              <code className="mx-1">/</code>. Leave blank to sync from the
              account root.
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
                placeholder=".md, .pdf, .docx"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of file extensions to include. Leave blank to
              sync all supported file types (.txt, .md, .csv, .json, .xml,
              .html, .log, .yaml, .pdf, .docx, .pptx).
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

      <FormField
        control={form.control}
        name={`${prefix}.includeSharedFolders`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Shared Folders</FormLabel>
              <FormDescription>
                Include files from team shared folders mounted at the path.
                Requires a team-scoped access token.
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
    </div>
  );
}
