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
import { Textarea } from "@/components/ui/textarea";

interface ServiceNowConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideUrl?: boolean;
}

export function ServiceNowConfigFields({
  form,
  prefix = "config",
  hideUrl = false,
}: ServiceNowConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {!hideUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.instanceUrl`}
          rules={{ required: "Instance URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Instance URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://your-instance.service-now.com"
                  {...field}
                />
              </FormControl>
              <FormDescription>Your ServiceNow instance URL.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.states`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>States (optional)</FormLabel>
            <FormControl>
              <Input placeholder="1, 2, 3" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of incident state values to filter by (e.g. 1
              = New, 2 = In Progress).
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.assignmentGroups`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Assignment Groups (optional)</FormLabel>
            <FormControl>
              <Input placeholder="sys_id_1, sys_id_2" {...field} />
            </FormControl>
            <FormDescription>
              Comma-separated list of assignment group sys_ids to filter by.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.query`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Encoded Query (optional)</FormLabel>
            <FormControl>
              <Textarea
                placeholder="short_descriptionLIKEnetwork^priority=1"
                rows={3}
                {...field}
              />
            </FormControl>
            <FormDescription>
              Custom ServiceNow encoded query to filter incidents.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.initialSyncMonths`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Initial Sync Period (months)</FormLabel>
            <FormControl>
              <Input
                type="number"
                placeholder="6"
                min={1}
                max={12}
                {...field}
                onChange={(e) => field.onChange(Number(e.target.value) || 6)}
              />
            </FormControl>
            <FormDescription>
              How many months of historical data to load on the first sync
              (default: 6, max: 12).
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.batchSize`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Batch Size</FormLabel>
            <FormControl>
              <Input
                type="number"
                placeholder="50"
                {...field}
                onChange={(e) => field.onChange(Number(e.target.value) || 50)}
              />
            </FormControl>
            <FormDescription>
              Number of incidents to process per batch (default: 50).
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
