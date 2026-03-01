"use client";

import { PROVIDERS_WITH_OPTIONAL_API_KEY } from "@shared";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  ChatApiKeyForm,
  type ChatApiKeyFormValues,
  PLACEHOLDER_KEY,
} from "@/components/chat-api-key-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChatApiKeys, useCreateChatApiKey } from "@/lib/chat-settings.query";
import { useFeatureFlag } from "@/lib/features.hook";
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
  const createMutation = useCreateChatApiKey();
  const byosEnabled = useFeatureFlag("byosEnabled");
  const geminiVertexAiEnabled = useFeatureFlag("geminiVertexAiEnabled");

  const hasAnyApiKey = chatApiKeys.length > 0;

  const form = useForm<ChatApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  useEffect(() => {
    if (isDialogOpen) {
      form.reset(DEFAULT_FORM_VALUES);
    }
  }, [isDialogOpen, form]);

  const formValues = form.watch();
  const isValid =
    formValues.apiKey !== PLACEHOLDER_KEY &&
    formValues.name &&
    (formValues.scope !== "team" || formValues.teamId) &&
    (byosEnabled
      ? formValues.vaultSecretPath && formValues.vaultSecretKey
      : PROVIDERS_WITH_OPTIONAL_API_KEY.has(formValues.provider) ||
        formValues.apiKey);

  const handleCreate = form.handleSubmit(async (values) => {
    try {
      await createMutation.mutateAsync({
        name: values.name,
        provider: values.provider,
        apiKey: values.apiKey || undefined,
        baseUrl: values.baseUrl || undefined,
        scope: values.scope,
        teamId:
          values.scope === "team" && values.teamId ? values.teamId : undefined,
        isPrimary: values.isPrimary,
        vaultSecretPath:
          byosEnabled && values.vaultSecretPath
            ? values.vaultSecretPath
            : undefined,
        vaultSecretKey:
          byosEnabled && values.vaultSecretKey
            ? values.vaultSecretKey
            : undefined,
      });
      setIsDialogOpen(false);
    } catch {
      // Error handled by mutation
    }
  });

  return (
    <>
      <SetupStep
        title="Setup LLM Provider Key"
        description="Connect an LLM provider so the agent can generate responses"
        done={hasAnyApiKey}
        ctaLabel="Add API Key"
        onAction={() => setIsDialogOpen(true)}
      />
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add API Key</DialogTitle>
            <DialogDescription>
              Add an LLM provider API key to start chatting
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleCreate}>
            <div className="py-2">
              <ChatApiKeyForm
                mode="full"
                showConsoleLink
                form={form}
                isPending={createMutation.isPending}
                geminiVertexAiEnabled={geminiVertexAiEnabled}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!isValid || createMutation.isPending}
              >
                {createMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Test & Create
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
