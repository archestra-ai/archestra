"use client";

import { E2eTestId } from "@shared";
import { CheckCircle2, Info, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { ArchestraArchitectureDiagram } from "@/components/archestra-architecture-diagram";
import {
  ChatApiKeyForm,
  type ChatApiKeyFormValues,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { ConnectionOptions } from "@/components/connection-options";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDefaultProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useChatApiKeys, useCreateChatApiKey } from "@/lib/chat-settings.query";
import {
  useOrganizationOnboardingStatus,
  useUpdateOrganization,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import Divider from "./divider";

interface OnboardingDialogProps {
  open: boolean;
}

const DEFAULT_FORM_VALUES: ChatApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: "",
  scope: "personal",
  teamId: "",
};

export function OnboardingDialog({ open }: OnboardingDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const { data: defaultProfile } = useDefaultProfile();
  const { data: onboardingStatus } = useOrganizationOnboardingStatus(
    open && step === 2,
  );
  const { mutate: completeOnboarding, isPending: completeOnboardingPending } =
    useUpdateOrganization(
      "Onboarding complete",
      "Failed to complete onboarding",
    );

  // Chat settings state
  const { data: chatApiKeys = [] } = useChatApiKeys();
  const { data: canUpdateChatSettings } = useHasPermissions({
    chatSettings: ["update"],
  });

  // Form and mutation for chat API key
  const chatApiKeyForm = useForm<ChatApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });
  const createChatApiKeyMutation = useCreateChatApiKey();

  // Check if any API key is configured (for any provider)
  const hasAnyApiKey = useMemo(() => {
    return chatApiKeys.some((k) => k.secretId);
  }, [chatApiKeys]);

  // Validation for chat API key form
  const formValues = chatApiKeyForm.watch();
  const isFormValid =
    formValues.apiKey && (formValues.scope !== "team" || formValues.teamId);

  const handleChatApiKeySubmit = chatApiKeyForm.handleSubmit(async (values) => {
    if (!values.apiKey) return;

    await createChatApiKeyMutation.mutateAsync({
      ...values,
      name: `Default ${PROVIDER_CONFIG[values.provider].name} Key`,
      teamId: values.scope === "team" ? values.teamId : undefined,
    });

    chatApiKeyForm.reset(DEFAULT_FORM_VALUES);
  });

  const handleFinishOnboarding = useCallback(() => {
    completeOnboarding({
      onboardingComplete: true,
    });
  }, [completeOnboarding]);

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        handleFinishOnboarding();
      }
    },
    [handleFinishOnboarding],
  );

  const handleNext = useCallback(() => {
    setStep(2);
  }, []);

  const handleBack = useCallback(() => {
    setStep(1);
  }, []);

  const bothConnected =
    onboardingStatus?.hasLlmProxyLogs && onboardingStatus?.hasMcpGatewayLogs;
  const hasAnyConnection =
    onboardingStatus?.hasLlmProxyLogs || onboardingStatus?.hasMcpGatewayLogs;

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-7xl h-[80vh] flex flex-col p-0">
        <div className="flex-1 overflow-y-auto px-6 pt-6 pb-6">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl">
              {step === 1 ? "Welcome to Archestra!" : "Connect External Agents"}
            </DialogTitle>
            <DialogDescription>
              {step === 1
                ? "Let's get you started with a quick overview"
                : "Optionally connect your external agents via LLM Proxy or MCP Gateway"}
            </DialogDescription>
          </DialogHeader>

          {step === 1 ? (
            <div className="space-y-6">
              {/* Overview section */}
              <div className="space-y-4">
                <p className="text-muted-foreground">
                  Archestra provides two ways to use the platform:
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg border p-4 space-y-2">
                    <h3 className="font-semibold">Chat</h3>
                    <p className="text-sm text-muted-foreground">
                      Built-in chat interface with MCP tool integration. Start
                      conversations with AI agents that have access to your
                      configured tools.
                    </p>
                  </div>
                  <div className="rounded-lg border p-4 space-y-2">
                    <h3 className="font-semibold">Connect External Agents</h3>
                    <p className="text-sm text-muted-foreground">
                      Route your existing agents (Cursor, N8N, etc.) through
                      Archestra's LLM Proxy and MCP Gateway for centralized
                      control.
                    </p>
                  </div>
                </div>
              </div>

              <Divider />

              <div>
                <h3 className="font-semibold">Chat Setup</h3>
                <p className="text-sm text-muted-foreground">
                  To use the built-in Chat feature, an LLM provider API key is
                  required.
                </p>
              </div>

              {/* Chat Setup section */}
              <div className="rounded-lg border p-4 space-y-4">
                {canUpdateChatSettings ? (
                  <>
                    <ChatApiKeyForm
                      mode="compact"
                      showConsoleLink
                      form={chatApiKeyForm}
                      existingKeys={chatApiKeys}
                      isPending={createChatApiKeyMutation.isPending}
                    />
                    <Button
                      onClick={handleChatApiKeySubmit}
                      disabled={
                        !isFormValid || createChatApiKeyMutation.isPending
                      }
                      size="sm"
                    >
                      {createChatApiKeyMutation.isPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {hasAnyApiKey ? "Update API Key" : "Save API Key"}
                    </Button>
                  </>
                ) : (
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>
                      {hasAnyApiKey ? (
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                          API key is configured. Chat is ready to use.
                        </span>
                      ) : (
                        "An administrator needs to configure an LLM provider API key to enable Chat. You can configure it later in Settings → Chat."
                      )}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <ArchestraArchitectureDiagram />
              <ConnectionOptions agentId={defaultProfile?.id} />
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t">
          {step === 1 ? (
            <div className="w-full flex justify-between">
              <Button
                onClick={handleFinishOnboarding}
                variant="ghost"
                size="lg"
                data-testid={E2eTestId.OnboardingSkipButton}
              >
                Skip Onboarding
              </Button>
              <Button
                onClick={handleNext}
                size="lg"
                data-testid={E2eTestId.OnboardingNextButton}
              >
                Next: Connect External Agents
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div
                className={cn(
                  "rounded-lg border p-4 transition-all duration-300",
                  bothConnected
                    ? "bg-green-500/10 border-green-500/50"
                    : hasAnyConnection
                      ? "bg-yellow-500/10 border-yellow-500/50"
                      : "bg-muted border-muted-foreground/20",
                )}
              >
                <div
                  className={cn(
                    "font-semibold mb-3 text-base",
                    bothConnected
                      ? "text-green-700 dark:text-green-400"
                      : hasAnyConnection
                        ? "text-yellow-700 dark:text-yellow-400"
                        : "text-muted-foreground",
                  )}
                >
                  {!hasAnyConnection
                    ? "Our Proxies are waiting to receive your first event"
                    : bothConnected
                      ? "Connection established!"
                      : onboardingStatus?.hasLlmProxyLogs
                        ? "LLM Proxy connected. You can also connect MCP Gateway"
                        : "MCP Gateway connected. You can also connect LLM Proxy"}
                </div>

                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    {onboardingStatus?.hasLlmProxyLogs ? (
                      <div className="relative">
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                        <div className="absolute inset-0 animate-ping">
                          <CheckCircle2 className="w-5 h-5 text-green-500 opacity-75" />
                        </div>
                      </div>
                    ) : (
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium">LLM Proxy</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {onboardingStatus?.hasMcpGatewayLogs ? (
                      <div className="relative">
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                        <div className="absolute inset-0 animate-ping">
                          <CheckCircle2 className="w-5 h-5 text-green-500 opacity-75" />
                        </div>
                      </div>
                    ) : (
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium">MCP Gateway</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <Button onClick={handleBack} variant="outline" size="lg">
                  Back
                </Button>

                <div className="flex items-center gap-4">
                  <Button
                    onClick={handleFinishOnboarding}
                    variant="link"
                    className="text-muted-foreground"
                  >
                    Skip this step
                  </Button>
                  <Button
                    onClick={handleFinishOnboarding}
                    disabled={completeOnboardingPending || !hasAnyConnection}
                    size="lg"
                    data-testid={E2eTestId.OnboardingFinishButton}
                  >
                    {completeOnboardingPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Finishing...
                      </>
                    ) : (
                      "Finish Onboarding"
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
