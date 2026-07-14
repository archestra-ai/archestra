// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import {
  DEFAULT_PERMISSION_SYNC_INTERVAL_SECONDS,
  PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
} from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const INTERVAL_OPTIONS: { seconds: number; label: string }[] = [
  {
    seconds: PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
    label: "Follow the documents sync schedule",
  },
  {
    seconds: DEFAULT_PERMISSION_SYNC_INTERVAL_SECONDS,
    label: "Every 30 minutes",
  },
  { seconds: 60 * 60, label: "Every hour" },
];

export function PermissionSyncIntervalPicker({
  form,
  name,
  connectorTypeLabel,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  name: string;
  connectorTypeLabel: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Permissions Sync Frequency</FormLabel>
          <Select
            value={String(field.value ?? "")}
            onValueChange={(value) => field.onChange(Number(value))}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an interval" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {INTERVAL_OPTIONS.map((option) => (
                <SelectItem key={option.seconds} value={String(option.seconds)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription>
            Pick how often to sync document permissions with your{" "}
            {connectorTypeLabel} instance
          </FormDescription>
        </FormItem>
      )}
    />
  );
}
