"use client";

import {
  SUBSCRIPTION_CREDENTIALS,
  subscriptionKindForProvider,
  subscriptionKindFromKeyMetadata,
} from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";

import { cn } from "@/lib/utils/tailwind";

type ReconnectCredential = Pick<LlmProviderApiKey, "id" | "name" | "provider"> &
  Partial<Pick<LlmProviderApiKey, "subscriptionKind">>;

export function SubscriptionReconnectNotice({
  credential,
  className,
  compact = false,
}: {
  credential: ReconnectCredential;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const kind =
    subscriptionKindFromKeyMetadata(credential) ??
    subscriptionKindForProvider(credential.provider);
  if (!kind) return null;
  const subscription = SUBSCRIPTION_CREDENTIALS[kind];
  return (
    <>
      {compact ? (
        <div
          role="alert"
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground",
            className,
          )}
        >
          <KeyRound className="size-3.5 shrink-0 text-amber-500" />
          <span>Sign-in expired</span>
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto shrink-0 p-0 text-xs"
            onClick={() => setOpen(true)}
          >
            Reconnect
          </Button>
        </div>
      ) : (
        <InlineNotice className={className}>
          <KeyRound />
          <span className="font-medium">
            {credential.name} needs reconnecting
          </span>
          <InlineNoticeText>Sign in again to continue.</InlineNoticeText>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto h-6 shrink-0 bg-background px-2 text-xs"
            onClick={() => setOpen(true)}
          >
            Reconnect
          </Button>
        </InlineNotice>
      )}
      {open && (
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={setOpen}
          title={`Reconnect ${subscription.displayName}`}
          description={subscription.connect.signInDescription}
          reconnectKeyId={credential.id}
          defaultValues={{
            name: credential.name,
            provider: credential.provider,
            shared: false,
            ...(subscription.marker !== null
              ? { authMethod: "subscription" }
              : {}),
          }}
          allowedProviders={[credential.provider]}
          credentialMode="subscription"
          requiresExactSubscriptionCredential
        />
      )}
    </>
  );
}
