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

interface OutlineConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function OutlineConfigFields({
  form,
  prefix = "config",
}: OutlineConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.collectionIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Collection IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="abc123, def456"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of Outline collection IDs to sync. Leave
              blank to sync all published documents the API key has access to.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
