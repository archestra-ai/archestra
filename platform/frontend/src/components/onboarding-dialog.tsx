"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import { ArchestraArchitectureDiagram } from "@/components/archestra-architecture-diagram";
import { ConnectionOptions } from "@/components/connection-options";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  const { data: defaultAgent } = useDefaultAgent();
  const { data: logsStatus } = useOnboardingLogs(open); // Only poll when dialog is open
  const completeOnboardingMutation = useCompleteOnboarding();

  const handleFinishOnboarding = async () => {
    await completeOnboardingMutation.mutateAsync();
  };

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">Welcome to Archestra!</DialogTitle>
          <DialogDescription>
            Let's get you started by connecting your first agent
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <ArchestraArchitectureDiagram />

          <div className="border-t pt-6">
            <ConnectionOptions agentId={defaultAgent?.id} />
          </div>

          {/* Status Section */}
          <div className="border-t pt-6">
            <h3 className="font-medium mb-4">Connection Status</h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-lg border">
                {logsStatus?.hasLlmProxyLogs ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
                    <span className="text-sm font-medium">
                      LLM Proxy request received
                    </span>
                  </>
                ) : (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground flex-shrink-0" />
                    <span className="text-sm text-muted-foreground">
                      Waiting for LLM Proxy request...
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-3 p-4 rounded-lg border">
                {logsStatus?.hasMcpGatewayLogs ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
                    <span className="text-sm font-medium">
                      MCP Gateway request received
                    </span>
                  </>
                ) : (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground flex-shrink-0" />
                    <span className="text-sm text-muted-foreground">
                      Waiting for MCP Gateway request...
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {(logsStatus?.hasLlmProxyLogs || logsStatus?.hasMcpGatewayLogs) && (
          <DialogFooter>
            <Button
              onClick={handleFinishOnboarding}
              disabled={completeOnboardingMutation.isPending}
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
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
