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
import { joinIfArray } from "./transform-config-array-fields";

export function PerforceConfigFields({
  form,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
}) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="config.fileTypes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>File Types (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder=".md, .yaml, .yml"
                {...field}
                value={joinIfArray(field.value)}
              />
            </FormControl>
            <FormDescription>
              Comma-separated file extensions to index. Defaults to .md, .yaml,
              .yml. Binary files are always skipped, so broader lists (e.g.
              .txt, .json) are safe to add.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="config.excludePaths"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Exclude Paths (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="//depot/docs/generated, //depot/docs/vendor"
                {...field}
                value={joinIfArray(field.value)}
              />
            </FormControl>
            <FormDescription>
              Comma-separated depot paths to skip within the synced depot paths.
              Useful to carve large or irrelevant subtrees out of a broad path.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="config.charset"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Charset (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="utf8"
                {...field}
                value={(field.value as string | undefined) ?? ""}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
              />
            </FormControl>
            <FormDescription>
              P4CHARSET for unicode-mode servers (commonly <code>utf8</code>).
              Leave empty for non-unicode servers.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
