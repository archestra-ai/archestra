"use client";

import { E2eTestId } from "@archestra/shared";
import { Plus } from "lucide-react";
import { useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";

const DEFAULT_FORM_VALUES: Partial<LlmProviderApiKeyFormValues> = {
  isPrimary: true,
};

/**
 * Empty state shown when the user has no usable LLM provider key — on the new
 * chat screen and the projects page. Lets them add a key inline; the create
 * mutation invalidates the keys query, so the calling screen reactively shows
 * its real content once a key exists.
 *
 * @param description subtitle under the heading; defaults to the chat copy so
 * each surface can phrase the "why" for its own context.
 * @param onKeyAdded extra work after a key is created (e.g. the chat screen
 * resets its URL). Optional — most callers just rely on the query refetch.
 */
export function NoApiKeySetup({
  description = "Connect an LLM provider to start chatting",
  onKeyAdded,
}: {
  description?: string;
  onKeyAdded?: () => void;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="text-center space-y-4">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Add an LLM Provider Key</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button
          data-testid={E2eTestId.QuickstartAddApiKeyButton}
          onClick={() => setIsDialogOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Add API Key
        </Button>
      </div>
      <CreateLlmProviderApiKeyDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title="Add API Key"
        description="Add an LLM provider API key to start chatting"
        defaultValues={DEFAULT_FORM_VALUES}
        showConsoleLink
        onSuccess={onKeyAdded}
      />
    </div>
  );
}
