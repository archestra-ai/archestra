"use client";

import { useState } from "react";
import type { ChatApiKeyFormValues } from "@/components/chat-api-key-form";
import { CreateChatApiKeyDialog } from "@/components/create-chat-api-key-dialog";
import { useChatApiKeys } from "@/lib/chat/chat-settings.query";
import { SetupStep } from "./setup-step";

const DEFAULT_FORM_VALUES: ChatApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: null,
  baseUrl: null,
  scope: "org_wide",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
};

export function LlmKeySetupStep() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { data: chatApiKeys = [] } = useChatApiKeys();

  const hasAnyApiKey = chatApiKeys.length > 0;

  return (
    <>
      <SetupStep
        title="Setup LLM Provider Key"
        description="Connect an LLM provider so the agent can generate responses"
        done={hasAnyApiKey}
        ctaLabel="Add API Key"
        onAction={() => setIsDialogOpen(true)}
      />
      <CreateChatApiKeyDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title="Add API Key"
        description="Add an LLM provider API key to start chatting"
        defaultValues={DEFAULT_FORM_VALUES}
        showConsoleLink
      />
    </>
  );
}
