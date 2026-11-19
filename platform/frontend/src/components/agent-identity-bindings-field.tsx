// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type archestraApiTypes,
  DocsPage,
  isEntraHostname,
  isOktaHostname,
} from "@archestra/shared";
import { Plus, X } from "lucide-react";
import { useId } from "react";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { IdentityProviderIcon } from "@/components/identity-provider-icons";
import { IdentityProviderSelectItem } from "@/components/identity-provider-select";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

type IdentityProvider =
  archestraApiTypes.GetIdentityProvidersResponses["200"][number];

/** Identity provider ID → the identity the agent acts as there. */
export type AgentIdentityBindingDrafts = Record<string, string>;

/**
 * The providers whose identity field the agent form shows: the agent's own
 * identity provider when it is set up for agent identities, and every
 * provider the agent holds or is adding an identity at.
 */
export function shownAgentIdentityProviders(params: {
  identityProviders: IdentityProvider[];
  selectedIdentityProviderId: string | null | undefined;
  bindings: AgentIdentityBindingDrafts;
}): IdentityProvider[] {
  return params.identityProviders.filter(
    (provider) =>
      provider.id in params.bindings ||
      (provider.id === params.selectedIdentityProviderId &&
        agentIdentityKind(provider) !== null),
  );
}

/**
 * Binds an agent to its own identity at identity providers set up for agent
 * identities. Tools exchange at the agent's own identity provider unless their
 * MCP server names another, so that provider's field comes first, and others
 * are added on demand. Changing one is an identity decision, so it takes
 * `identityProvider:update`, the same as the backend's check.
 */
export function AgentIdentityBindingsField({
  agentId,
  identityProviders,
  selectedIdentityProviderId,
  value,
  onChange,
}: {
  /** Null while the agent is being created. */
  agentId: string | null;
  identityProviders: IdentityProvider[];
  selectedIdentityProviderId: string | null | undefined;
  value: AgentIdentityBindingDrafts;
  onChange: (value: AgentIdentityBindingDrafts) => void;
}) {
  const inputIdPrefix = useId();
  const spiffe = useFeature("agentIdentitySpiffe");
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformAgentIdentity);
  const { data: canUpdateIdentityProviders } = useHasPermissions({
    identityProvider: ["update"],
  });
  const shown = shownAgentIdentityProviders({
    identityProviders,
    selectedIdentityProviderId,
    bindings: value,
  });
  // A SPIFFE ID needs no adding: the agent has one wherever it is taken.
  const addable = identityProviders.filter((provider) => {
    const kind = agentIdentityKind(provider);
    return (
      kind !== null &&
      kind !== "spiffe" &&
      !shown.some((shownProvider) => shownProvider.id === provider.id)
    );
  });
  const canEdit = !!canUpdateIdentityProviders;

  return (
    <div className="space-y-4">
      <FieldDescription>
        Tools that exchange the user&apos;s token then run as the user, through
        this agent. Downstream tokens name the agent, so the identity
        provider&apos;s consents, policies and logs apply to this agent alone.
        Leave it empty to use the shared client.
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
      {shown.map((provider) => {
        const inputId = `${inputIdPrefix}-${provider.id}`;
        const kind = agentIdentityKind(provider) ?? "actor";
        if (kind === "spiffe") {
          return (
            <SpiffeIdentity
              key={provider.id}
              provider={provider}
              spiffeId={
                spiffe
                  ? `spiffe://${spiffe.trustDomain}/agent/${agentId ?? "<agent ID>"}`
                  : null
              }
              pending={!agentId}
            />
          );
        }
        const copy = FIELD_COPY[kind];
        const removable = provider.id !== selectedIdentityProviderId;
        return (
          <div key={provider.id} className="space-y-2">
            <Label htmlFor={inputId}>
              <span>{copy.label}</span>
              <span className="inline-flex items-center gap-1 font-normal text-muted-foreground">
                <IdentityProviderIcon
                  providerId={provider.providerId}
                  size={14}
                  className="shrink-0"
                />
                {provider.providerId}
              </span>
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={inputId}
                value={value[provider.id] ?? ""}
                onChange={(event) =>
                  onChange({ ...value, [provider.id]: event.target.value })
                }
                placeholder={copy.placeholder}
                className="font-mono"
                disabled={!canEdit}
              />
              {removable && canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove the identity at ${provider.providerId}`}
                  onClick={() => {
                    const { [provider.id]: _removed, ...rest } = value;
                    onChange(rest);
                  }}
                >
                  <X />
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {canEdit && addable.length > 0 && (
        <Select
          value=""
          onValueChange={(identityProviderId) =>
            onChange({ ...value, [identityProviderId]: "" })
          }
        >
          <SelectTrigger size="sm" className="w-fit">
            <Plus />
            <SelectValue placeholder="Add an identity at another provider" />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="start"
            className="w-[min(32rem,var(--radix-popper-available-width))]"
          >
            {addable.map((provider) => (
              <IdentityProviderSelectItem
                key={provider.id}
                provider={provider}
              />
            ))}
          </SelectContent>
        </Select>
      )}
      {!canEdit && (
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

/** Whether any identity provider is set up for agent identities. */
export function hasAgentIdentityProviders(
  identityProviders: IdentityProvider[],
): boolean {
  return identityProviders.some(
    (provider) => agentIdentityKind(provider) !== null,
  );
}

// === internal ===

type AgentIdentityKind = "entra" | "okta" | "actor" | "spiffe";

/**
 * The agent's SPIFFE ID at a provider that takes those: derived from the
 * agent, so shown, not entered.
 */
function SpiffeIdentity({
  provider,
  spiffeId,
  pending,
}: {
  provider: IdentityProvider;
  spiffeId: string | null;
  pending: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span>SPIFFE ID</span>
        <span className="inline-flex items-center gap-1 font-normal text-muted-foreground">
          <IdentityProviderIcon
            providerId={provider.providerId}
            size={14}
            className="shrink-0"
          />
          {provider.providerId}
        </span>
      </div>
      <div className="flex min-h-9 items-center gap-1 rounded-md border bg-muted/30 px-3 font-mono text-sm">
        <span className="truncate" title={spiffeId ?? undefined}>
          {spiffeId ?? "—"}
        </span>
        {spiffeId && !pending && <CopyButton text={spiffeId} size={12} />}
      </div>
      <FieldDescription>
        {pending
          ? "Assigned when the agent is saved. Nothing to register per agent: the identity provider trusts every agent through the SPIFFE issuer."
          : "Sent as a JWT-SVID with each token exchange. Nothing to register per agent: the identity provider trusts every agent through the SPIFFE issuer."}
      </FieldDescription>
    </div>
  );
}

const FIELD_COPY: Record<
  Exclude<AgentIdentityKind, "spiffe">,
  { label: string; placeholder: string }
> = {
  entra: {
    label: "Entra agent identity app ID",
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  okta: {
    label: "Okta AI agent client ID",
    placeholder: "wlp8x5q7mvH86KvFJ0g7",
  },
  actor: {
    label: "Agent client ID",
    placeholder: "support-agent",
  },
};

/**
 * How agents get their own identity at the provider, as the backend decides
 * it: an Entra Agent ID blueprint for Entra On-Behalf-Of, SPIFFE IDs when an
 * RFC 8693 provider takes those, else a stored agent key (redacted on read,
 * so the provider lists it as stored).
 */
function agentIdentityKind(
  provider: IdentityProvider,
): AgentIdentityKind | null {
  const enterpriseConfig = provider.oidcConfig?.enterpriseManagedCredentials;
  if (!enterpriseConfig) return null;
  const strategy =
    enterpriseConfig.exchangeStrategy ?? inferExchangeStrategy(provider.issuer);
  if (strategy === "entra_obo") {
    return enterpriseConfig.entraAgentId?.blueprintClientId?.trim()
      ? "entra"
      : null;
  }
  if (
    strategy === "rfc8693" &&
    enterpriseConfig.agentIdentity?.source === "spiffe"
  ) {
    return "spiffe";
  }
  if (
    !provider.configuredSecretPaths.includes(
      "oidcConfig.enterpriseManagedCredentials.agentIdentity.privateKeyPem",
    )
  ) {
    return null;
  }
  return strategy === "okta_managed" ? "okta" : "actor";
}

function inferExchangeStrategy(
  issuer: string,
): "entra_obo" | "okta_managed" | "rfc8693" {
  let hostname = "";
  try {
    hostname = new URL(issuer).hostname;
  } catch {
    return "rfc8693";
  }
  if (isEntraHostname(hostname)) return "entra_obo";
  if (isOktaHostname(hostname)) return "okta_managed";
  return "rfc8693";
}
