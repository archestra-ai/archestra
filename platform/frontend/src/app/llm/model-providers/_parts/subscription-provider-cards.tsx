"use client";

import { E2eTestId, SUBSCRIPTION_CREDENTIALS } from "@archestra/shared";
import { CheckCircle2, Unplug } from "lucide-react";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { SubscriptionBrandIcon } from "@/components/subscription-brand-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import type { SubscriptionOffer } from "./subscription-offers";

/**
 * The subscriptions a person can connect with their own vendor account, one
 * card each, above the credentials table.
 *
 * They used to be rows in that table, which read as "credentials somebody
 * already configured" and buried the one thing that makes them different: you
 * do not need an API key, you sign in. Cards state the offer, its connection
 * status, and the one action that applies to it.
 */
export function SubscriptionProviderCards({
  offers,
  isLoading,
  onConnect,
  onManage,
  onDisconnect,
  disconnectBlockedReason,
}: {
  offers: SubscriptionOffer[];
  /** The viewer's keys have not arrived yet, so no status can be stated. */
  isLoading: boolean;
  onConnect: (offer: SubscriptionOffer) => void;
  onManage: (credential: LlmProviderApiKeyResponse) => void;
  onDisconnect: (credential: LlmProviderApiKeyResponse) => void;
  /** Why this key cannot be disconnected, or null when it can. */
  disconnectBlockedReason: (
    credential: LlmProviderApiKeyResponse,
  ) => string | null;
}) {
  if (offers.length === 0) return null;

  return (
    <section
      className="space-y-3"
      aria-labelledby="personal-subscriptions-heading"
      data-testid={E2eTestId.SubscriptionProviderCards}
    >
      <div className="space-y-1">
        <h2 id="personal-subscriptions-heading" className="text-sm font-medium">
          Personal subscriptions
        </h2>
        <p className="text-sm text-muted-foreground">
          Sign in with a vendor account to use a subscription you already pay
          for — no API key needed. Each person connects their own account.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {offers.map((offer) => (
          <SubscriptionProviderCard
            key={offer.kind}
            offer={offer}
            isLoading={isLoading}
            onConnect={onConnect}
            onManage={onManage}
            onDisconnect={onDisconnect}
            disconnectBlockedReason={disconnectBlockedReason}
          />
        ))}
      </div>
    </section>
  );
}

function SubscriptionProviderCard({
  offer,
  isLoading,
  onConnect,
  onManage,
  onDisconnect,
  disconnectBlockedReason,
}: {
  offer: SubscriptionOffer;
  isLoading: boolean;
  onConnect: (offer: SubscriptionOffer) => void;
  onManage: (credential: LlmProviderApiKeyResponse) => void;
  onDisconnect: (credential: LlmProviderApiKeyResponse) => void;
  disconnectBlockedReason: (
    credential: LlmProviderApiKeyResponse,
  ) => string | null;
}) {
  const { credential } = offer;
  const copy = SUBSCRIPTION_CREDENTIALS[offer.kind].connect;
  const blockedReason = credential ? disconnectBlockedReason(credential) : null;

  return (
    <Card
      className="gap-3 px-4 py-4"
      data-testid={`${E2eTestId.SubscriptionProviderCard}-${offer.kind}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SubscriptionBrandIcon
          kind={offer.kind}
          provider={offer.provider}
          size={20}
        />
        <span className="min-w-0 truncate font-medium" title={offer.name}>
          {offer.name}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {credential ? copy.connectedDescription : copy.signInDescription}
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        {isLoading ? (
          <Skeleton className="h-4 w-24" />
        ) : credential ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
            <span>Connected</span>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Not connected</span>
        )}
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : credential ? (
          <div className="flex shrink-0 items-center gap-1">
            <PermissionButton
              permissions={{ llmProviderApiKey: ["update"] }}
              variant="outline"
              size="sm"
              onClick={() => onManage(credential)}
            >
              <span>Manage</span>
            </PermissionButton>
            {/* Icon-only: the card is narrow enough at four across that a
                second worded button would be clipped. */}
            <PermissionButton
              permissions={{ llmProviderApiKey: ["delete"] }}
              variant="ghost"
              size="icon-sm"
              aria-label="Disconnect"
              className="text-destructive hover:text-destructive"
              disabled={blockedReason !== null}
              tooltip={blockedReason ?? "Disconnect"}
              onClick={() => onDisconnect(credential)}
            >
              <Unplug className="h-4 w-4" />
            </PermissionButton>
          </div>
        ) : (
          // Personal subscription creation is intentionally self-service on the
          // backend, including for default members who only have key-read
          // permission. Do not apply the admin API-key create gate here.
          <Button variant="outline" size="sm" onClick={() => onConnect(offer)}>
            <span>Connect</span>
          </Button>
        )}
      </div>
    </Card>
  );
}
