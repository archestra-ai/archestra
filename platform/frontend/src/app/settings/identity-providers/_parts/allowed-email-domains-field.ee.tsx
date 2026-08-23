// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { IdentityProviderFormValues } from "@archestra/shared";
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

interface AllowedEmailDomainsFieldProps {
  form: UseFormReturn<IdentityProviderFormValues>;
}

export function AllowedEmailDomainsField({
  form,
}: AllowedEmailDomainsFieldProps) {
  return (
    <FormField
      control={form.control}
      name="domain"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Allowed Email Domains</FormLabel>
          <FormControl>
            <Input placeholder="company.com, subsidiary.com" {...field} />
          </FormControl>
          <FormDescription>
            Users can sign in with this provider only when their returned email
            matches one of these domains. Separate multiple domains with commas.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
