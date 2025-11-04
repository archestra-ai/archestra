"use client";

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

interface OnboardingDialogProps {
  open: boolean;
}

export function OnboardingDialog({ open }: OnboardingDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const { data: defaultAgent } = useDefaultAgent();
  const { data: logsStatus } = useOnboardingLogs(open && step === 2); // Only poll when on step 2
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
            <div className="w-full flex justify-end">
              <Button onClick={handleNext} size="lg">
                Next: Connect Agent
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-6">
              <Button onClick={handleBack} variant="outline" size="lg">
                Back
              </Button>

              <div className="flex-1 text-center">
                <div className="text-sm font-medium mb-2">
                  {!logsStatus?.hasLlmProxyLogs &&
                  !logsStatus?.hasMcpGatewayLogs
                    ? "Our Proxies are waiting to receive your first event"
                    : logsStatus?.hasLlmProxyLogs &&
                        logsStatus?.hasMcpGatewayLogs
                      ? "Connection established!"
                      : logsStatus?.hasLlmProxyLogs
                        ? "LLM Proxy connected. You can also connect MCP Gateway"
                        : "MCP Gateway connected. You can also connect LLM Proxy"}
                </div>
                <div className="flex items-center justify-center gap-4 text-xs">
                  <div className="flex items-center gap-1.5">
                    {logsStatus?.hasLlmProxyLogs ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    )}
                    <span>LLM Proxy</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {logsStatus?.hasMcpGatewayLogs ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    )}
                    <span>MCP Gateway</span>
                  </div>
                </div>
              </div>

              <Button
                onClick={handleFinishOnboarding}
                disabled={
                  completeOnboardingMutation.isPending ||
                  (!logsStatus?.hasLlmProxyLogs &&
                    !logsStatus?.hasMcpGatewayLogs)
                }
                size="lg"
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
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
