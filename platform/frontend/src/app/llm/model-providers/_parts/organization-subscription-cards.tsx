"use client";

import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  SubscriptionCard,
  SubscriptionCardsSection,
} from "./subscription-provider-cards";

/**
 * Subscriptions an organization pays for, which members use without a seat of
 * their own: today, GitHub Copilot through a GitHub App on the organization.
 * The cards are the personal subscription cards, one per connected
 * organization, with the same states and actions.
 */
export function OrganizationSubscriptionCards({
  credentials,
  isLoading,
  onConnect,
  onReconnect,
  onManage,
  onDisconnect,
  disconnectBlockedReason,
}: {
  /** The organization's GitHub Copilot keys (GitHub App credentials). */
  credentials: LlmProviderApiKeyResponse[];
  isLoading: boolean;
  onConnect: () => void;
  onReconnect: (credential: LlmProviderApiKeyResponse) => void;
  onManage: (credential: LlmProviderApiKeyResponse) => void;
  onDisconnect: (credential: LlmProviderApiKeyResponse) => void;
  /** Why this key cannot be disconnected, or null when it can. */
  disconnectBlockedReason: (
    credential: LlmProviderApiKeyResponse,
  ) => string | null;
}) {
  return (
    <SubscriptionCardsSection
      id="organization-subscriptions-heading"
      heading="Enterprise plans"
      description="Connect your business account. Can be shared."
    >
      {credentials.length === 0 ? (
        <SubscriptionCard
          kind="github-copilot"
          provider="github-copilot"
          name="GitHub Copilot"
          description="Connect your enterprise GitHub Copilot plan."
          isLoading={isLoading}
          status="not-connected"
          onConnect={onConnect}
          connectPermissions={{ llmProviderApiKey: ["create"] }}
        />
      ) : (
        credentials.map((credential) => (
          <SubscriptionCard
            key={credential.id}
            kind="github-copilot"
            provider="github-copilot"
            name="GitHub Copilot"
            description={
              credential.requiresReauthentication
                ? "GitHub refused the App. Its installation or private key changed. Reconnect it to use this plan."
                : `Your organization's Copilot plan is linked through a GitHub App. Usage is billed to ${credential.githubOrganization ?? "the organization"}.`
            }
            isLoading={isLoading}
            status={
              credential.requiresReauthentication ? "reconnect" : "connected"
            }
            onConnect={() => onReconnect(credential)}
            manage={{
              onClick: () => onManage(credential),
              permissionScope: credential.id,
            }}
            disconnect={{
              permissions: { llmProviderApiKey: ["delete"] },
              permissionScope: credential.id,
              blockedReason: disconnectBlockedReason(credential),
              onClick: () => onDisconnect(credential),
            }}
          />
        ))
      )}
    </SubscriptionCardsSection>
  );
}
