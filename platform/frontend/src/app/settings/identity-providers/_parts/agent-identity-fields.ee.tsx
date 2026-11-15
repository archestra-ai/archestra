// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  DocsPage,
  type IdentityProviderFormValues,
  type IdentityProviderSecretPath,
} from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import { CopyButton } from "@/components/copy-button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { IdentityProviderSectionHeader } from "./identity-provider-section-header.ee";

/**
 * Agent identities at Okta (Okta AI agents) and other RFC 8693 providers. With
 * an agent key, each agent is its own client there: one key signs for every
 * agent, and the admin registers its public key on each agent's client. An
 * RFC 8693 provider can instead take the SPIFFE ID Archestra issues every
 * agent, sent as a JWT-SVID it trusts through Archestra's issuer.
 */
export function AgentIdentityFields(props: {
  form: UseFormReturn<IdentityProviderFormValues>;
  isSecretStored: (path: IdentityProviderSecretPath) => boolean;
  exchangeType: "okta_managed" | "rfc8693";
}) {
  const { form, isSecretStored, exchangeType } = props;
  const appName = useAppName();
  const source =
    form.watch(
      "oidcConfig.enterpriseManagedCredentials.agentIdentity.source",
    ) ?? "client";
  const usesSpiffe = exchangeType === "rfc8693" && source === "spiffe";
  const docsUrl = getFrontendDocsUrl(
    exchangeType === "okta_managed"
      ? DocsPage.PlatformAgentIdentityOkta
      : usesSpiffe
        ? DocsPage.PlatformAgentIdentitySpiffe
        : DocsPage.PlatformAgentIdentityActorTokens,
  );

  return (
    <div className="space-y-4">
      <IdentityProviderSectionHeader title="Agent Identities">
        {exchangeType === "okta_managed"
          ? "Let each agent sign in to Okta as its own AI agent. Tools then call downstream APIs as the user, through that agent, so Okta's delegation rules and logs apply per agent. Bind an agent to its AI agent in the agent's settings."
          : "Let each agent present its own identity as the actor in the token exchange, so downstream tokens name the user and the agent."}
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

      {exchangeType === "rfc8693" && (
        <FormField
          control={form.control}
          name="oidcConfig.enterpriseManagedCredentials.agentIdentity.source"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Agent Identity</FormLabel>
              <FormDescription>
                What each agent proves itself with.
              </FormDescription>
              <Select
                value={field.value ?? "client"}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem
                    value="client"
                    description="Each agent is a client at the identity provider; bind it in the agent's settings."
                  >
                    The agent&apos;s own client
                  </SelectItem>
                  <SelectItem
                    value="spiffe"
                    description={`${appName} issues every agent a SPIFFE ID; nothing to register per agent.`}
                  >
                    SPIFFE ID (JWT-SVID)
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {usesSpiffe ? (
        <SpiffeFields form={form} />
      ) : (
        <ClientKeyFields
          form={form}
          exchangeType={exchangeType}
          privateKeyStored={isSecretStored(
            "oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem",
          )}
        />
      )}

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
                {usesSpiffe
                  ? `Refuse tool calls that no agent makes, such as an app's, instead of running them through the shared ${appName} client.`
                  : `Refuse tool calls from agents without their own client, instead of running them through the shared ${appName} client.`}
              </FormDescription>
            </div>
          </FormItem>
        )}
      />
    </div>
  );
}

// === internal ===

function ClientKeyFields(props: {
  form: UseFormReturn<IdentityProviderFormValues>;
  exchangeType: "okta_managed" | "rfc8693";
  privateKeyStored: boolean;
}) {
  const { form, exchangeType, privateKeyStored } = props;
  const appName = useAppName();
  return (
    <>
      <FormField
        control={form.control}
        name="oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Agent Private Key</FormLabel>
            <FormDescription>
              PKCS#8 PEM key {appName} signs each agent client&apos;s assertions
              with. Register its public key on every agent&apos;s client.
              {privateKeyStored &&
                " A key is already stored: leave blank to keep it, or enter a new key to replace it."}
            </FormDescription>
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

      <div className="grid items-start gap-4 md:grid-cols-2">
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
    </>
  );
}

/**
 * The issuer the identity provider must trust, to copy into its settings, and
 * the audience each JWT-SVID is addressed to.
 */
function SpiffeFields(props: {
  form: UseFormReturn<IdentityProviderFormValues>;
}) {
  const spiffe = useFeature("agentIdentitySpiffe");
  const issuer = props.form.watch("issuer");
  return (
    <>
      {spiffe && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Trust this issuer at the identity provider, for actor tokens of type{" "}
            <code>urn:ietf:params:oauth:token-type:jwt</code>. Each agent acts
            as <code>spiffe://{spiffe.trustDomain}/agent/&lt;agent ID&gt;</code>
            .
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs">
            <IssuerDetail label="Trust domain" value={spiffe.trustDomain} />
            <IssuerDetail label="Issuer" value={spiffe.issuer} />
            <IssuerDetail label="JWKS URL" value={spiffe.jwksUri} />
            <IssuerDetail label="SPIFFE bundle" value={spiffe.bundleUri} />
          </dl>
        </div>
      )}
      <FormField
        control={props.form.control}
        name="oidcConfig.enterpriseManagedCredentials.agentIdentity.spiffeAudience"
        render={({ field }) => (
          <FormItem>
            <FormLabel>JWT-SVID Audience (Optional)</FormLabel>
            <FormDescription>
              The <code>aud</code> each agent&apos;s JWT-SVID names. Defaults to
              this identity provider&apos;s issuer.
            </FormDescription>
            <FormControl>
              <Input
                placeholder={issuer || "https://idp.example.com/realms/acme"}
                className="font-mono"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}

function IssuerDetail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono" title={value}>
          {value}
        </span>
        <CopyButton text={value} size={12} />
      </dd>
    </>
  );
}
