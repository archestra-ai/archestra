"use client";

import { E2eTestId } from "@archestra/shared";
import { useState } from "react";
import { ConnectProviderCards } from "@/components/connect-provider-cards";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { UseSubscriptionDialog } from "@/components/use-subscription-dialog";

const DEFAULT_FORM_VALUES: Partial<LlmProviderApiKeyFormValues> = {
  isPrimary: true,
};

/**
 * Empty state shown when the user has no usable LLM provider key — on the new
 * chat screen and the projects page. Presents the two ways to connect a model
 * (paste an API key, or use a subscription) as the shared two-door chooser. Both
 * create mutations invalidate the keys query, so the calling screen reactively
 * shows its real content once a credential exists.
 *
 * @param description subtitle under the heading; omit to use the default chooser
 * copy, or pass a surface-specific "why".
 * @param onKeyAdded extra work after a credential is created (e.g. the chat
 * screen resets its URL). Optional — most callers just rely on the query refetch.
 */
export function NoApiKeySetup({
  description,
  onKeyAdded,
}: {
  description?: string;
  onKeyAdded?: () => void;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSubscriptionOpen, setIsSubscriptionOpen] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <ConnectProviderCards
        description={description}
        addKeyTestId={E2eTestId.QuickstartAddApiKeyButton}
        onAddKey={() => setIsDialogOpen(true)}
        onUseSubscription={() => setIsSubscriptionOpen(true)}
      />
      <CreateLlmProviderApiKeyDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title="Add API Key"
        description="Add an LLM provider API key to start chatting"
        defaultValues={DEFAULT_FORM_VALUES}
        showConsoleLink
        onSuccess={onKeyAdded}
        onUseSubscription={() => setIsSubscriptionOpen(true)}
      />
      <UseSubscriptionDialog
        open={isSubscriptionOpen}
        onOpenChange={setIsSubscriptionOpen}
        onConnected={onKeyAdded}
      />
    </div>
  );
}
