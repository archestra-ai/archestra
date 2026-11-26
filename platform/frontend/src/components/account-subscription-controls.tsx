"use client";

import {
  personalSubscriptionTurnedOffMessage,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Unplug } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  DeleteApiKeyDescription,
  PROVIDER_KEY_CONFIRM_DELAY_MS,
  useLlmProviderKeyDependents,
} from "@/components/llm-provider-key-delete";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useDeleteLlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";

// A person's own subscription other than Claude's, signed in to and
// disconnected where their runs of an agent say they use it. Claude keeps an
// account of its own, in `ClaudeCodeAccount`.

/**
 * Signs the viewer in to their subscription, in a dialog on this page. A
 * subscription the admins turned off says so instead: its sign-in would be
 * refused.
 */
export function SubscriptionSignInButton({
  kind,
  size = "sm",
  variant,
  className,
}: {
  kind: SubscriptionCredentialKind;
  /** `xs` inside a notice; the card's own size otherwise. */
  size?: "sm" | "xs";
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const refresh = useRefreshAgentAccounts();
  const providerCatalog = useModelProviderCatalog();
  const { provider, label, marker, connect } = SUBSCRIPTION_CREDENTIALS[kind];
  if (!providerCatalog.canAddPersonalSubscription(provider)) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={personalSubscriptionTurnedOffMessage(
          providerCatalog.overrides,
          provider,
        )}
      >
        Turned off
      </span>
    );
  }
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        onClick={() => setOpen(true)}
      >
        <span>Sign in</span>
      </Button>
      {open && (
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={setOpen}
          title={connect.signInTitle}
          description={connect.signInDescription}
          defaultValues={{
            name: providerCatalog.personalSubscriptionLabel(provider, label),
            provider,
            shared: false,
            // A subscription that shares its provider with ordinary API keys
            // opens on the subscription tab; the others have no tabs.
            ...(marker !== null ? { authMethod: "subscription" as const } : {}),
          }}
          allowedProviders={[provider]}
          credentialMode="subscription"
          onSuccess={refresh}
        />
      )}
    </>
  );
}

/**
 * Disconnects the viewer's own subscription. One click when nothing else
 * goes with its key. A key that virtual keys or OAuth clients map alone asks
 * first, in the dialog Model Providers uses, and one a knowledge base runs on
 * cannot be disconnected from here, as there.
 */
export function SubscriptionDisconnectButton({
  keyId,
  label,
}: {
  keyId: string;
  /** The subscription's name, for the question the dialog asks. */
  label: string;
}) {
  const remove = useDeleteLlmProviderApiKey();
  const refresh = useRefreshAgentAccounts();
  const dependents = useLlmProviderKeyDependents({ keyId });
  const [confirming, setConfirming] = useState(false);
  const blockedReason =
    dependents.knowledgeBaseUsages.length > 0
      ? `Used for knowledge base ${dependents.knowledgeBaseUsages.join(" and ")}. Remove it from Settings > Knowledge before disconnecting.`
      : null;
  const disconnect = (onSuccess?: () => void) =>
    remove.mutate(
      { id: keyId, kind: "subscription" },
      { onSuccess, onSettled: refresh },
    );
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The span takes the pointer while the button is disabled, so
                the reason still shows. */}
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Disconnect"
                disabled={remove.isPending || blockedReason !== null}
                onClick={() => {
                  // Asked first whenever something goes with the key, and
                  // while that is not known yet.
                  if (!dependents.known || dependents.hasDependents) {
                    setConfirming(true);
                    return;
                  }
                  disconnect();
                }}
              >
                <Unplug />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {blockedReason ?? "Disconnect your subscription"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DeleteConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect subscription"
        description={
          <DeleteApiKeyDescription
            apiKey={{ id: keyId, name: label }}
            isSubscription
            knowledgeBaseUsages={dependents.knowledgeBaseUsages}
            virtualKeys={dependents.virtualKeys}
            oauthClients={dependents.oauthClients}
            isLoading={dependents.isLoading}
          />
        }
        isPending={remove.isPending}
        onConfirm={() => disconnect(() => setConfirming(false))}
        confirmDisabled={dependents.isLoading}
        confirmDelayMs={PROVIDER_KEY_CONFIRM_DELAY_MS}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting..."
      />
    </>
  );
}

/**
 * A person's subscription serves every agent that runs on it, so connecting
 * or disconnecting it refreshes what all of them show, as the Claude account
 * does.
 */
function useRefreshAgentAccounts() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["agents"] });
  };
}
