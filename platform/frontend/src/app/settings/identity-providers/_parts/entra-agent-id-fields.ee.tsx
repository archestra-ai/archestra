// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  DocsPage,
  type IdentityProviderFormValues,
  type IdentityProviderSecretPath,
} from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SecretInput, SecretTextarea } from "@/components/ui/secret-input";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { IdentityProviderSectionHeader } from "./identity-provider-section-header.ee";

/**
 * Microsoft Entra Agent ID: the agent identity blueprint that tool calls run
 * through when an agent is bound to its own Entra agent identity.
 */
export function EntraAgentIdFields(props: {
  form: UseFormReturn<IdentityProviderFormValues>;
  isSecretStored: (path: IdentityProviderSecretPath) => boolean;
}) {
  const { form, isSecretStored } = props;
  const appName = useAppName();
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformEntraAgentId);
  const secretStored = isSecretStored(
    "oidcConfig.enterpriseManagedCredentials.entraAgentId.clientSecret",
  );
  const privateKeyStored = isSecretStored(
    "oidcConfig.enterpriseManagedCredentials.entraAgentId.privateKeyPem",
  );

  return (
    <div className="space-y-4">
      <IdentityProviderSectionHeader title="Entra Agent ID">
        Give each agent its own Microsoft Entra identity. Tools then call
        downstream APIs as the user, through that agent, so Entra consent,
        Conditional Access, and sign-in logs apply per agent. Bind an agent to
        its identity in the agent&apos;s settings.
        {docsUrl && (
          <ExternalDocsLink
            href={docsUrl}
            className="ml-1 underline underline-offset-4"
            showIcon={false}
          >
            Learn more
          </ExternalDocsLink>
        )}
      </IdentityProviderSectionHeader>

      <FormField
        control={form.control}
        name="oidcConfig.enterpriseManagedCredentials.entraAgentId.blueprintClientId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Agent Identity Blueprint Client ID</FormLabel>
            <FormDescription>
              The blueprint&apos;s application (client) ID. Leave empty to turn
              Entra Agent ID off.
            </FormDescription>
            <FormControl>
              <Input
                placeholder="00000000-0000-0000-0000-000000000000"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="oidcConfig.enterpriseManagedCredentials.entraAgentId.clientSecret"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Blueprint Client Secret</FormLabel>
            <FormDescription>
              For testing. In production, use a certificate below instead.
            </FormDescription>
            <StoredNote stored={secretStored} />
            <FormControl>
              <SecretInput
                placeholder={secretStored ? "••••••••" : "Optional"}
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.entraAgentId.certificateThumbprint"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Certificate Thumbprint</FormLabel>
              <FormDescription>
                As Entra shows it under the blueprint&apos;s certificates.
              </FormDescription>
              <FormControl>
                <Input
                  placeholder="40 hexadecimal characters"
                  className="font-mono"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.entraAgentId.blueprintScope"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Blueprint Scope (Optional)</FormLabel>
              <FormDescription>
                Addresses the user&apos;s token to the blueprint. Defaults to{" "}
                <code>api://&lt;blueprint-client-id&gt;/.default</code>.
              </FormDescription>
              <FormControl>
                <Input
                  placeholder="api://<blueprint-client-id>/.default"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="oidcConfig.enterpriseManagedCredentials.entraAgentId.privateKeyPem"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Certificate Private Key</FormLabel>
            <FormDescription>
              PKCS#8 PEM key of the certificate uploaded to the blueprint. Used
              instead of the client secret when set.
            </FormDescription>
            <StoredNote stored={privateKeyStored} />
            <FormControl>
              <SecretTextarea
                placeholder={
                  privateKeyStored ? "••••••••" : "-----BEGIN PRIVATE KEY-----"
                }
                className="min-h-32 font-mono text-xs"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="oidcConfig.enterpriseManagedCredentials.entraAgentId.requireAgentIdentity"
        render={({ field }) => (
          <FormItem className="flex flex-row items-start gap-2 space-y-0">
            <FormControl>
              <Checkbox
                checked={field.value ?? false}
                onCheckedChange={(checked) => field.onChange(checked === true)}
              />
            </FormControl>
            <div className="space-y-1">
              <FormLabel>Require an agent identity</FormLabel>
              <FormDescription className="text-xs">
                Refuse tool calls from agents without their own identity,
                instead of running them through the shared {appName} client.
              </FormDescription>
            </div>
          </FormItem>
        )}
      />
    </div>
  );
}

function StoredNote({ stored }: { stored: boolean }) {
  if (!stored) return null;
  return (
    <FormDescription>
      A value is already stored. Leave blank to keep it, or enter a new value to
      replace.
    </FormDescription>
  );
}
