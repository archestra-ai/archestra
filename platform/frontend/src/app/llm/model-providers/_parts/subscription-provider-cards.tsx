"use client";

import {
  E2eTestId,
  type Permissions,
  SUBSCRIPTION_CREDENTIALS,
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
  isLoading,
  currentUserId,
  onConnect,
  onManage,
  onDisconnect,
  disconnectBlockedReason,
}: {
  offers: SubscriptionOffer[];
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
  if (offers.length === 0) return null;

  return (
    <SubscriptionCardsSection
      id="personal-subscriptions-heading"
      heading="Personal subscriptions"
      description="Sign in with a vendor account to use a subscription you already pay for — no API key needed. Each person connects their own account."
      testId={E2eTestId.SubscriptionProviderCards}
    >
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
export function SubscriptionCardsSection({
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
  | "not-connected";

/**
 * One subscription card, personal or organization: brand and name, what the
 * subscription is, its status, and the actions that apply to it.
 */
export function SubscriptionCard({
  testId,
  kind,
  provider,
  name,
  description,
  isLoading,
  status,
  onConnect,
  connectPermissions,
  manage,
  disconnect,
}: {
  testId?: string;
  kind: SubscriptionOffer["kind"];
  provider: SubscriptionOffer["provider"];
  name: string;
  description: string;
  isLoading: boolean;
  status: SubscriptionCardStatus;
  /** Connect when not connected, Reconnect when the credential was refused. */
  onConnect: () => void;
  /** Gates connecting; omitted, connecting is self-service. */
  connectPermissions?: Permissions;
  manage?: {
    onClick: () => void;
    permissionScope: string;
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
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        {isLoading ? (
          <Skeleton className="h-4 w-24" />
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
        ) : status !== "not-connected" ? (
          <div className="flex shrink-0 items-center gap-1">
            {status === "reconnect" || !manage ? (
              <Button variant="outline" size="sm" onClick={onConnect}>
                <span>Reconnect</span>
              </Button>
            ) : (
              <PermissionButton
                permissions={{ llmProviderApiKey: ["update"] }}
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
        ) : (
          <ConnectButton onClick={onConnect} permissions={connectPermissions} />
        )}
      </div>
    </Card>
  );
}

function ConnectButton({
  onClick,
  permissions,
}: {
  onClick: () => void;
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
    <SubscriptionCard
      testId={`${E2eTestId.SubscriptionProviderCard}-${offer.kind}`}
      kind={offer.kind}
      provider={offer.provider}
      name={offer.name}
      description={
        credential?.requiresReauthentication
          ? "Your sign-in expired or was revoked. Sign in again to use this subscription."
          : credential
            ? copy.connectedDescription
            : copy.signInDescription
      }
      isLoading={isLoading}
      status={
        !credential
          ? "not-connected"
          : credential.requiresReauthentication
            ? "reconnect"
            : "connected"
      }
      // Personal subscription creation is intentionally self-service on the
      // backend, including for default members who only have key-read
      // permission. Do not apply the admin API-key create gate here.
      onConnect={() => onConnect(offer)}
      manage={
        credential
          ? {
              onClick: () => onManage(credential),
              permissionScope: credential.id,
            }
          : undefined
      }
      disconnect={
        credential
          ? {
              // Personal subscription deletion is self-service. The ownership
              // and usage checks above supply any refusal, independently of RBAC.
              permissions: {},
              blockedReason,
              onClick: () => onDisconnect(credential),
            }
          : undefined
      }
    />
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
