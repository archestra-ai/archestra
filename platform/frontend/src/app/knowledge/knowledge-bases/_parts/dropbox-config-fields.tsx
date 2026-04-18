"use client";

import type { Control } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

// biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
export function DropboxConfigFields({ control }: { control: Control<any> }) {
  return (
    <div className="space-y-4">
      <FormField
        control={control}
        name="config.rootPath"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Folder Path</FormLabel>
            <FormControl>
              <Input
                placeholder="/optional/folder/path"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              The folder to sync. Leave empty to sync the entire account.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="config.fileTypes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>File Types (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder=".md, .txt, .json"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated file extensions to include. Leave empty to sync
              all supported types.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
