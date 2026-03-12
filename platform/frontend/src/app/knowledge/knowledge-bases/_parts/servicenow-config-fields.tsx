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
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

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
        name={`${prefix}.includeIncidents`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Incidents</FormLabel>
              <FormDescription>
                Sync incidents from the incident table.
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
        name={`${prefix}.includeChanges`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Changes</FormLabel>
              <FormDescription>
                Sync change requests from the change_request table.
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

      <FormField
        control={form.control}
        name={`${prefix}.includeChangeRequests`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Change Tasks</FormLabel>
              <FormDescription>
                Sync change tasks from the change_task table.
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

      <FormField
        control={form.control}
        name={`${prefix}.includeProblems`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Problems</FormLabel>
              <FormDescription>
                Sync problems from the problem table.
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

      <FormField
        control={form.control}
        name={`${prefix}.includeBusinessApps`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Business Applications</FormLabel>
              <FormDescription>
                Sync business applications from the CMDB. States and assignment
                group filters do not apply to this entity.
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
              Comma-separated list of state values to filter by (e.g. 1 = New, 2
              = In Progress). Applies to incidents, changes, change tasks, and
              problems.
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
        name={`${prefix}.syncDataForLastMonths`}
        render={({ field }) => {
          const value = field.value ?? 6;
          return (
            <FormItem className="rounded-lg border p-4">
              <div className="flex items-baseline justify-between">
                <FormLabel className="text-base font-semibold">
                  Initial sync window
                </FormLabel>
                <span className="text-right">
                  <span className="text-2xl font-bold">{value}</span>{" "}
                  <span className="text-muted-foreground text-sm">months</span>
                </span>
              </div>
              <FormControl>
                <Slider
                  min={1}
                  max={12}
                  step={1}
                  value={[value]}
                  onValueChange={([v]) => field.onChange(v)}
                />
              </FormControl>
              <div className="text-muted-foreground flex justify-between text-xs">
                <span>1 mo</span>
                <span>12 mo</span>
              </div>
              <FormDescription>
                Historical data loaded on first sync
              </FormDescription>
            </FormItem>
          );
        }}
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
              Number of records to process per batch (default: 50).
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
