// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { type archestraApiTypes, DocsPage } from "@archestra/shared";
import { useId } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

type IdentityProvider =
  archestraApiTypes.GetIdentityProvidersResponses["200"][number];

/** Identity provider ID → the identity the agent acts as there. */
export type AgentIdentityBindingDrafts = Record<string, string>;

/**
 * The providers an agent can hold an identity at: those set up for agent
 * identities, and any it is still bound at so the binding can be cleared.
 */
export function agentIdentityProviders(params: {
  identityProviders: IdentityProvider[];
  bindings: AgentIdentityBindingDrafts;
}): IdentityProvider[] {
  return params.identityProviders.filter(
    (provider) =>
      agentIdentityKind(provider) !== null ||
      !!params.bindings[provider.id]?.trim(),
  );
}

/**
 * Binds an agent to its own identity at each identity provider set up for
 * agent identities. Changing one is an identity decision, so it takes
 * `identityProvider:update`, the same as the backend's check.
 */
export function AgentIdentityBindingsField({
  identityProviders,
  value,
  onChange,
}: {
  identityProviders: IdentityProvider[];
  value: AgentIdentityBindingDrafts;
  onChange: (value: AgentIdentityBindingDrafts) => void;
}) {
  const inputIdPrefix = useId();
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformAgentIdentity);
  const { data: canUpdateIdentityProviders } = useHasPermissions({
    identityProvider: ["update"],
  });

  return (
    <div className="space-y-4">
      <FieldDescription>
        Tools that exchange the user&apos;s token then run as the user, through
        this agent. Downstream tokens name the agent, so the identity
        provider&apos;s consents, policies and logs apply to this agent alone.
        Leave a field empty to use the shared client.
        {docsUrl && (
          <ExternalDocsLink
            href={docsUrl}
            className="ml-1 underline"
            showIcon={false}
          >
            Learn more
          </ExternalDocsLink>
        )}
      </FieldDescription>
      {identityProviders.map((provider) => {
        const inputId = `${inputIdPrefix}-${provider.id}`;
        const copy = FIELD_COPY[agentIdentityKind(provider) ?? "client"];
        return (
          <div key={provider.id} className="space-y-2">
            <Label htmlFor={inputId}>
              {provider.providerId}: {copy.label}
            </Label>
            <Input
              id={inputId}
              value={value[provider.id] ?? ""}
              onChange={(event) =>
                onChange({ ...value, [provider.id]: event.target.value })
              }
              placeholder={copy.placeholder}
              className="font-mono"
              disabled={!canUpdateIdentityProviders}
            />
          </div>
        );
      })}
      {!canUpdateIdentityProviders && (
        <FieldDescription>
          Changing them requires permission to update identity providers.
        </FieldDescription>
      )}
    </div>
  );
}

/** The bindings to save: one per provider with a non-empty identity. */
export function agentIdentityBindingsToSave(
  drafts: AgentIdentityBindingDrafts,
): Array<{ identityProviderId: string; externalId: string }> {
  return Object.entries(drafts)
    .map(([identityProviderId, externalId]) => ({
      identityProviderId,
      externalId: externalId.trim(),
    }))
    .filter((binding) => binding.externalId.length > 0)
    .sort((a, b) => a.identityProviderId.localeCompare(b.identityProviderId));
}

// === internal ===

type AgentIdentityKind = "entra" | "client";

const FIELD_COPY: Record<
  AgentIdentityKind,
  { label: string; placeholder: string }
> = {
  entra: {
    label: "Entra agent identity app ID",
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  client: {
    label: "agent client ID (Okta AI agent or the agent's own client)",
    placeholder: "wlp8x5q7mvH86KvFJ0g7",
  },
};

function agentIdentityKind(
  provider: IdentityProvider,
): AgentIdentityKind | null {
  const enterpriseConfig = provider.oidcConfig?.enterpriseManagedCredentials;
  if (enterpriseConfig?.entraAgentId?.blueprintClientId?.trim()) {
    return "entra";
  }
  // The key is redacted on read; the provider lists it as stored instead.
  return provider.configuredSecretPaths.includes(
    "oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem",
  )
    ? "client"
    : null;
}
