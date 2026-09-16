// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface SharePointConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function SharePointConfigFields({
  form,
  prefix = "config",
}: SharePointConfigFieldsProps) {
  const includePages = form.watch(`${prefix}.includePages`) !== false;
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.driveIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Drive IDs (optional)</FormLabel>
            <FormDescription>
              Comma-separated list of document library (drive) IDs to sync.
              Leave blank to sync all document libraries in the site.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="b!abc123, b!def456"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
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
            <FormDescription>
              Restrict sync to a specific folder path within each drive.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="General/Documents/Engineering"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
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
              <FormLabel>Recursive</FormLabel>
              <FormDescription>
                Traverse subfolders and include files from all nested
                directories.
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
        name={`${prefix}.includePages`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Pages</FormLabel>
              <FormDescription>
                Sync site pages and their web part content.
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
      {includePages && (
        <FormField
          control={form.control}
          name={`${prefix}.pagePublicationStatus`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Page publication status</FormLabel>
              <FormDescription>
                Filters the current page version, not earlier published
                versions. Previously indexed pages outside this selection are
                removed on the next sync. Document library files are unaffected.
              </FormDescription>
              <Select
                value={field.value ?? "both"}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem
                    value="published"
                    description="Sync pages whose current version is published."
                  >
                    Published only
                  </SelectItem>
                  <SelectItem
                    value="draft"
                    description="Sync pages whose current version is a draft."
                  >
                    Draft only
                  </SelectItem>
                  <SelectItem
                    value="both"
                    description="Sync all accessible pages, regardless of publication status."
                  >
                    Both
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  );
}
