"use client";

import { DocsPage, type IdentityProviderFormValues } from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

interface SsoLoginEnabledFieldProps {
  form: UseFormReturn<IdentityProviderFormValues>;
}

export function SsoLoginEnabledField({ form }: SsoLoginEnabledFieldProps) {
  const linkedDownstreamIdpDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformEnterpriseManagedAuth,
    "linked-downstream-idps",
  );

  return (
    <FormField
      control={form.control}
      name="ssoLoginEnabled"
      render={({ field }) => (
        <FormItem className="flex flex-row items-start gap-3 rounded-md border p-3">
          <FormControl>
            <Checkbox
              checked={field.value ?? true}
              onCheckedChange={field.onChange}
            />
          </FormControl>
          <div className="space-y-1 leading-none">
            <FormLabel>Use for Single Sign-On</FormLabel>
            <FormDescription>
              When disabled, this provider is hidden from the sign-in page and
              role mapping and team sync never run for it. Disable this for
              providers used only to link delegated tokens for MCP tool
              authentication.{" "}
              <ExternalDocsLink href={linkedDownstreamIdpDocsUrl}>
                Learn more
              </ExternalDocsLink>
            </FormDescription>
          </div>
        </FormItem>
      )}
    />
  );
}
