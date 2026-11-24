"use client";

import {
  E2eTestId,
  type Permissions,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
} from "@archestra/shared";
import { CheckCircle2, TriangleAlert, Unplug } from "lucide-react";
import type { ReactNode } from "react";
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
  leadingCards,
  isLoading,
  currentUserId,
  onConnect,
  onManage,
  onDisconnect,
  disconnectBlockedReason,
}: {
  offers: SubscriptionOffer[];
  /** Additional personal subscription cards rendered before registry offers. */
  leadingCards?: ReactNode;
  /** The viewer's keys have not arrived yet, so no status can be stated. */
  isLoading: boolean;
  /** Session user, to recognize the viewer's own credential on a card. */
  currentUserId: string | null | undefined;
  onConnect: (offer: SubscriptionOffer) => void;
  onManage: (credential: LlmProviderApiKeyResponse) => void;
  onDisconnect: (credential: LlmProviderApiKeyResponse) => void;
  /** Why this key cannot be disconnected, or null when it can. */
  disconnectBlockedReason: (
    credential: LlmProviderApiKeyResponse,
  ) => string | null;
}) {
  if (offers.length === 0 && !leadingCards) return null;

  return (
    <SubscriptionCardsSection
      id="personal-subscriptions-heading"
      heading="Personal subscriptions"
      description="Sign in with a vendor account to use a subscription you already pay for — no API key needed. Each person connects their own account."
      testId={E2eTestId.SubscriptionProviderCards}
    >
      {leadingCards}
      {offers.map((offer) => (
        <PersonalSubscriptionCard
          key={offer.kind}
          offer={offer}
          isLoading={isLoading}
          currentUserId={currentUserId}
          onConnect={onConnect}
          onManage={onManage}
          onDisconnect={onDisconnect}
          disconnectBlockedReason={disconnectBlockedReason}
        />
      ))}
    </SubscriptionCardsSection>
  );
}

/** A heading, its explanation, and the shared card grid. */
function SubscriptionCardsSection({
  id,
  heading,
  description,
  testId,
  children,
}: {
  id: string;
  heading: string;
  description: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" aria-labelledby={id} data-testid={testId}>
      <div className="space-y-1">
        <h2 id={id} className="text-sm font-medium">
          {heading}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {children}
      </div>
    </section>
  );
}

export type SubscriptionCardStatus =
  | "connected"
  | "reconnect"
  | "not-connected"
  | "error";

/**
 * One subscription card: brand and name, what the subscription is, its status,
 * and the actions that apply to it.
 */
export function SubscriptionCard({
  testId,
  kind,
  provider,
  name,
  description,
  notice,
  isLoading,
  status,
  onConnect,
  onRetry,
  connectPermissions,
  connectAction,
  manage,
  disconnect,
}: {
  testId?: string;
  kind?: SubscriptionOffer["kind"] | null;
  provider: SupportedProvider;
  name: string;
  description?: string;
  /** Optional inline notice shown below the description (or as the card body). */
  notice?: ReactNode;
  isLoading: boolean;
  status: SubscriptionCardStatus;
  /** Connect when not connected, Reconnect when the credential was refused. */
  onConnect?: () => void;
  /** Retries checking connection status when `status === "error"`. */
  onRetry?: () => void;
  /** Gates connecting; omitted, connecting is self-service. */
  connectPermissions?: Permissions;
  /**
   * Connects on the card itself (a sign-in flow, say) in place of the Connect
   * button, on its own line under the status.
   */
  connectAction?: ReactNode;
  manage?: {
    onClick: () => void;
    permissions?: Permissions;
    permissionScope?: string;
  };
  disconnect?: {
    onClick: () => void;
    permissions: Permissions;
    permissionScope?: string;
    blockedReason: string | null;
  };
}) {
  return (
    <Card className="gap-3 px-4 py-4" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-2">
        <SubscriptionBrandIcon kind={kind} provider={provider} size={20} />
        <span className="min-w-0 truncate font-medium" title={name}>
          {name}
        </span>
      </div>
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {notice}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        {isLoading ? (
          <Skeleton className="h-4 w-24" />
        ) : status === "error" ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" />
            <span>Could not check connection</span>
          </span>
        ) : status !== "not-connected" ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {status === "reconnect" ? (
              <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
            )}
            <span>
              {status === "reconnect" ? "Reconnect required" : "Connected"}
            </span>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Not connected</span>
        )}
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : status === "error" ? (
          onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <span>Retry</span>
            </Button>
          ) : null
        ) : status !== "not-connected" ? (
          <div className="flex shrink-0 items-center gap-1">
            {status === "reconnect" || !manage ? (
              onConnect ? (
                <Button variant="outline" size="sm" onClick={onConnect}>
                  <span>Reconnect</span>
                </Button>
              ) : null
            ) : (
              <PermissionButton
                permissions={
                  manage.permissions ?? { llmProviderApiKey: ["update"] }
                }
                permissionScope={manage.permissionScope}
                variant="outline"
                size="sm"
                onClick={manage.onClick}
              >
                <span>Manage</span>
              </PermissionButton>
            )}
            {/* Icon-only: the card is narrow enough at four across that a
                second worded button would be clipped. */}
            {disconnect && (
              <PermissionButton
                permissions={disconnect.permissions}
                permissionScope={disconnect.permissionScope}
                variant="ghost"
                size="icon-sm"
                aria-label="Disconnect"
                className="text-destructive hover:text-destructive"
                disabled={disconnect.blockedReason !== null}
                tooltip={disconnect.blockedReason ?? "Disconnect"}
                onClick={disconnect.onClick}
              >
                <Unplug className="h-4 w-4" />
              </PermissionButton>
            )}
          </div>
        ) : connectAction ? (
          <div className="basis-full">{connectAction}</div>
        ) : onConnect ? (
          <ConnectButton onClick={onConnect} permissions={connectPermissions} />
        ) : null}
      </div>
    </Card>
  );
}

function ConnectButton({
  onClick,
  permissions,
}: {
  onClick: (() => void) | undefined;
  permissions: Permissions | undefined;
}) {
  return permissions ? (
    <PermissionButton
      permissions={permissions}
      variant="outline"
      size="sm"
      onClick={onClick}
    >
      <span>Connect</span>
    </PermissionButton>
  ) : (
    <Button variant="outline" size="sm" onClick={onClick}>
      <span>Connect</span>
    </Button>
  );
}

function PersonalSubscriptionCard({
  offer,
  isLoading,
  currentUserId,
  onConnect,
  onManage,
  onDisconnect,
  disconnectBlockedReason,
}: {
  offer: SubscriptionOffer;
  isLoading: boolean;
  currentUserId: string | null | undefined;
  onConnect: (offer: SubscriptionOffer) => void;
  onManage: (credential: LlmProviderApiKeyResponse) => void;
  onDisconnect: (credential: LlmProviderApiKeyResponse) => void;
  disconnectBlockedReason: (
    credential: LlmProviderApiKeyResponse,
  ) => string | null;
}) {
  const { credential } = offer;
  const copy = SUBSCRIPTION_CREDENTIALS[offer.kind].connect;
  // Personal credentials are owner-managed; admin permissions do not override
  // ownership. Keep this guard while the session is still loading, too.
  const blockedReason = credential
    ? !isOwnPersonalCredential(credential, currentUserId)
      ? "You can only disconnect your own personal subscription."
      : disconnectBlockedReason(credential)
    : null;

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
        {credential?.requiresReauthentication
          ? "Your sign-in expired or was revoked. Sign in again to use this subscription."
          : credential
            ? copy.connectedDescription
            : copy.signInDescription}
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        {isLoading ? (
          <Skeleton className="h-4 w-24" />
        ) : credential ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {credential.requiresReauthentication ? (
              <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
            )}
            <span>
              {credential.requiresReauthentication
                ? "Reconnect required"
                : "Connected"}
            </span>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Not connected</span>
        )}
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : credential ? (
          <div className="flex shrink-0 items-center gap-1">
            {credential.requiresReauthentication ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onConnect(offer)}
              >
                <span>Reconnect</span>
              </Button>
            ) : (
              <PermissionButton
                permissions={{ llmProviderApiKey: ["update"] }}
                permissionScope={credential.id}
                variant="outline"
                size="sm"
                onClick={() => onManage(credential)}
              >
                <span>Manage</span>
              </PermissionButton>
            )}
            {/* Icon-only: the card is narrow enough at four across that a
                second worded button would be clipped. */}
            <PermissionButton
              // Personal subscription deletion is self-service. The ownership
              // and usage checks above supply any refusal, independently of RBAC.
              permissions={{}}
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

/**
 * Whether `credential` is the viewer's own personal subscription key — the one
 * case the backend lets delete without the llmProviderApiKey:delete permission.
 */
function isOwnPersonalCredential(
  credential: LlmProviderApiKeyResponse | null,
  currentUserId: string | null | undefined,
): boolean {
  return (
    credential !== null &&
    credential.scope === "personal" &&
    currentUserId != null &&
    credential.userId === currentUserId
  );
}
