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
import { SecretTextarea } from "@/components/ui/secret-input";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { IdentityProviderSectionHeader } from "./identity-provider-section-header.ee";

/**
 * Agent identities at Okta (Okta AI agents) and other RFC 8693 providers
 * (each agent's own client, sent as the actor). One key signs for every
 * agent; the admin registers its public key on each agent's client.
 */
export function AgentIdentityFields(props: {
  form: UseFormReturn<IdentityProviderFormValues>;
  isSecretStored: (path: IdentityProviderSecretPath) => boolean;
  exchangeType: "okta_managed" | "rfc8693";
}) {
  const { form, isSecretStored, exchangeType } = props;
  const appName = useAppName();
  const docsUrl = getFrontendDocsUrl(
    exchangeType === "okta_managed"
      ? DocsPage.PlatformAgentIdentityOkta
      : DocsPage.PlatformAgentIdentityActorTokens,
  );
  const privateKeyStored = isSecretStored(
    "oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem",
  );

  return (
    <div className="space-y-4">
      <IdentityProviderSectionHeader title="Agent Identities">
        {exchangeType === "okta_managed"
          ? "Let each agent sign in to Okta as its own AI agent. Tools then call downstream APIs as the user, through that agent, so Okta's delegation rules and logs apply per agent."
          : "Let each agent present its own client's token as the actor in the token exchange, so downstream tokens name the user and the agent."}{" "}
        Bind an agent to its client in the agent&apos;s settings.
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
        name="oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Agent Private Key</FormLabel>
            <FormDescription>
              PKCS#8 PEM key {appName} signs each agent client&apos;s assertions
              with. Register its public key on every agent&apos;s client.
            </FormDescription>
            {privateKeyStored && (
              <FormDescription>
                A key is already stored. Leave blank to keep it, or enter a new
                key to replace it.
              </FormDescription>
            )}
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

      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Key ID</FormLabel>
              <FormDescription>
                The <code>kid</code> the public key is registered under.
              </FormDescription>
              <FormControl>
                <Input
                  placeholder="archestra-agents"
                  className="font-mono"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {exchangeType === "rfc8693" && (
          <FormField
            control={form.control}
            name="oidcConfig.enterpriseManagedCredentials.agentIdentity.actorTokenScope"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Actor Token Scope (Optional)</FormLabel>
                <FormDescription>
                  Scope requested in the agent&apos;s own token.
                </FormDescription>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </div>

      <FormField
        control={form.control}
        name="oidcConfig.enterpriseManagedCredentials.agentIdentity.requireAgentIdentity"
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
                Refuse tool calls from agents without their own client, instead
                of running them through the shared {appName} client.
              </FormDescription>
            </div>
          </FormItem>
        )}
      />
    </div>
  );
}
