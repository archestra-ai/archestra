"use client";

import { E2eTestId } from "@shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { ArchestraArchitectureDiagram } from "@/components/archestra-architecture-diagram";
import { ConnectionOptions } from "@/components/connection-options";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDefaultAgent } from "@/lib/agent.query";
import {
  useCompleteOnboarding,
  useOnboardingLogs,
} from "@/lib/onboarding.query";
import { cn } from "@/lib/utils";

interface OnboardingDialogProps {
  open: boolean;
}

export function OnboardingDialog({ open }: OnboardingDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const { data: defaultAgent } = useDefaultAgent();
  const { data: logsStatus } = useOnboardingLogs(open && step === 2);
  const completeOnboardingMutation = useCompleteOnboarding();

  const handleFinishOnboarding = async () => {
    await completeOnboardingMutation.mutateAsync();
  };

  const handleNext = () => {
    setStep(2);
  };

  const handleBack = () => {
    setStep(1);
  };

  const bothConnected =
    logsStatus?.hasLlmProxyLogs && logsStatus?.hasMcpGatewayLogs;
  const hasAnyConnection =
    logsStatus?.hasLlmProxyLogs || logsStatus?.hasMcpGatewayLogs;

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-7xl h-[80vh] flex flex-col p-0">
        <div className="flex-1 overflow-y-auto px-6 pt-6 pb-6">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl">
              {step === 1 ? "Welcome to Archestra!" : "Connect and Verify"}
            </DialogTitle>
            <DialogDescription>
              {step === 1
                ? "Let's get you started with a quick overview"
                : "Configure your agent and verify the connection"}
            </DialogDescription>
          </DialogHeader>

          {step === 1 ? (
            <div className="space-y-6">
              <ArchestraArchitectureDiagram />
            </div>
          ) : (
            <div className="space-y-6">
              <ConnectionOptions agentId={defaultAgent?.id} />
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
                Next: Connect Agent
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Status Card */}
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
                      : logsStatus?.hasLlmProxyLogs
                        ? "LLM Proxy connected. You can also connect MCP Gateway"
                        : "MCP Gateway connected. You can also connect LLM Proxy"}
                </div>

                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    {logsStatus?.hasLlmProxyLogs ? (
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
                    {logsStatus?.hasMcpGatewayLogs ? (
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

              {/* Action Buttons */}
              <div className="flex items-center justify-between gap-4">
                <Button onClick={handleBack} variant="outline" size="lg">
                  Back
                </Button>

                <Button
                  onClick={handleFinishOnboarding}
                  disabled={
                    completeOnboardingMutation.isPending || !hasAnyConnection
                  }
                  size="lg"
                  data-testid={E2eTestId.OnboardingFinishButton}
                >
                  {completeOnboardingMutation.isPending ? (
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
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
