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

const ROLE_AUDIENCE_TABLES = [
  { table: "incident", label: "Incidents" },
  { table: "change_request", label: "Changes" },
  { table: "change_task", label: "Change Tasks" },
  { table: "problem", label: "Problems" },
  { table: "cmdb_ci_business_app", label: "Business Applications" },
] as const;

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
              <FormDescription>Your ServiceNow instance URL.</FormDescription>
              <FormControl>
                <Input
                  placeholder="https://your-instance.service-now.com"
                  {...field}
                />
              </FormControl>
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
        name={`${prefix}.includeKnowledgeArticles`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Include Knowledge Articles</FormLabel>
              <FormDescription>
                Sync published knowledge articles from the kb_knowledge table.
                States and assignment group filters do not apply to this entity.
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

      <div className="space-y-3 rounded-lg border p-3">
        <div className="space-y-0.5">
          <FormLabel>Role audiences (auto-sync permissions)</FormLabel>
          <FormDescription>
            Only used with auto-sync permissions. Comma-separated ServiceNow
            role names (e.g. itil) whose holders may read every synced record of
            that table. Without roles, a record is visible only to its
            participants: assignment group members, the caller, the opener, and
            the assignee.
          </FormDescription>
        </div>
        {ROLE_AUDIENCE_TABLES.map(({ table, label }) => (
          <FormField
            key={table}
            control={form.control}
            name={`${prefix}.roleAudiences.${table}`}
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-normal">{label}</FormLabel>
                <FormControl>
                  <Input
                    placeholder="itil"
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
      </div>

      <FormField
        control={form.control}
        name={`${prefix}.states`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>States (optional)</FormLabel>
            <FormDescription>
              Comma-separated list of state values to filter by (e.g. 1 = New, 2
              = In Progress). Applies to incidents, changes, change tasks, and
              problems.
            </FormDescription>
            <FormControl>
              <Input placeholder="1, 2, 3" {...field} />
            </FormControl>
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
            <FormDescription>
              Comma-separated list of assignment group sys_ids to filter by.
            </FormDescription>
            <FormControl>
              <Input placeholder="sys_id_1, sys_id_2" {...field} />
            </FormControl>
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
              <FormDescription>
                Historical data loaded on first sync
              </FormDescription>
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
            <FormDescription>
              Number of records to process per batch (default: 50).
            </FormDescription>
            <FormControl>
              <Input
                type="number"
                placeholder="50"
                {...field}
                onChange={(e) => field.onChange(Number(e.target.value) || 50)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
