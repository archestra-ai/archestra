"use client";

import { useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { SetupStep } from "./setup-step";

const DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: null,
  baseUrl: null,
  extraHeaders: [],
  scope: "org",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
};

export function LlmKeySetupStep() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { data: chatApiKeys = [] } = useLlmProviderApiKeys();

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
      <CreateLlmProviderApiKeyDialog
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
