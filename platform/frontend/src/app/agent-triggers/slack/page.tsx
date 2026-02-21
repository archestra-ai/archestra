"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import Divider from "@/components/divider";
import { SlackAgentSetupDialog } from "@/components/slack-agent-setup-dialog";
import { SlackSetupDialog } from "@/components/slack-setup-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useProfiles } from "@/lib/agent.query";
import { useChatOpsBindings, useChatOpsStatus } from "@/lib/chatops.query";
import config from "@/lib/config";
import { useFeatures } from "@/lib/config.query";
import { usePublicBaseUrl } from "@/lib/features.hook";
import { AgentTilesSection } from "../_components/agent-tiles-section";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { CredentialField } from "../_components/credential-field";
import { SetupStep } from "../_components/setup-step";
import type { ProviderConfig } from "../_components/types";

const slackProviderConfig: ProviderConfig = {
  provider: "slack",
  providerLabel: "Slack",
  providerIcon: "/icons/slack.png",
  webhookPath: "/api/webhooks/chatops/slack",
  docsUrl: "https://archestra.ai/docs/platform-slack",
  slashCommand: "/select-agent",
  buildDeepLink: (binding) => {
    if (binding.workspaceId) {
      return `slack://channel?team=${binding.workspaceId}&id=${binding.channelId}`;
    }
    return `slack://channel?id=${binding.channelId}`;
  },
  getDmDeepLink: (providerStatus) => {
    const { botUserId, teamId } = providerStatus.dmInfo ?? {};
    if (!botUserId || !teamId) return null;
    return `slack://user?team=${teamId}&id=${botUserId}`;
  },
};

export default function SlackPage() {
  const publicBaseUrl = usePublicBaseUrl();
  const queryClient = useQueryClient();
  const [slackSetupOpen, setSlackSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);
  const [slackAgentDialogOpen, setSlackAgentDialogOpen] = useState(false);

  const { data: features, isLoading: featuresLoading } = useFeatures();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();
  const { data: bindings, isLoading: bindingsLoading } = useChatOpsBindings();
  const { data: agents, isLoading: agentsLoading } = useProfiles({
    filters: { agentType: "agent" },
  });

  const ngrokDomain = features?.ngrokDomain;
  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const slackCreds = slack?.credentials as Record<string, string> | undefined;

  const slackAgentIds = new Set(
    agents
      ?.filter((a) =>
        Array.isArray(a.allowedChatops)
          ? a.allowedChatops.includes("slack")
          : false,
      )
      .map((a) => a.id) ?? [],
  );
  const hasBindings =
    !!bindings &&
    bindings.some(
      (b) =>
        b.provider === "slack" &&
        !b.isDm &&
        b.agentId &&
        slackAgentIds.has(b.agentId),
    );

  const setupDataLoading =
    featuresLoading || statusLoading || bindingsLoading || agentsLoading;
  const isLocalDev =
    features?.isQuickstart || config.environment === "development";
  const allStepsCompleted = isLocalDev
    ? !!ngrokDomain && !!slack?.configured && hasBindings
    : !!slack?.configured && hasBindings;

  return (
    <div className="flex flex-col gap-6">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={setupDataLoading}
        providerLabel="Slack"
        docsUrl="https://archestra.ai/docs/platform-slack"
      >
        {isLocalDev ? (
          <SetupStep
            title="Make Archestra reachable from the Internet"
            description="The Slack bot needs to connect to an Archestra webhook — your instance must be publicly accessible"
            done={!!ngrokDomain}
            ctaLabel="Configure ngrok"
            onAction={() => setNgrokDialogOpen(true)}
          >
            {ngrokDomain ? (
              <>
                Ngrok domain{" "}
                <code className="bg-muted px-1 py-0.5 rounded text-xs">
                  {ngrokDomain}
                </code>{" "}
                is configured.
              </>
            ) : (
              <>
                Archestra's webhook{" "}
                <code className="bg-muted px-1 py-0.5 rounded text-xs">
                  POST {`${publicBaseUrl}/api/webhooks/chatops/slack`}
                </code>{" "}
                needs to be reachable from the Internet. Configure ngrok or
                deploy to a public URL.
              </>
            )}
          </SetupStep>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3">
            <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-sm">
                Archestra's webhook must be reachable from the Internet
              </span>
              <span className="text-muted-foreground text-xs">
                The webhook endpoint{" "}
                <code className="bg-muted px-1 py-0.5 rounded text-xs">
                  POST {`${publicBaseUrl}/api/webhooks/chatops/slack`}
                </code>{" "}
                must be publicly accessible so Slack can deliver events to
                Archestra
              </span>
            </div>
          </div>
        )}
        <SetupStep
          title="Setup Slack"
          description="Create a Slack App from manifest and connect it to Archestra"
          done={!!slack?.configured}
          ctaLabel="Setup Slack"
          onAction={() => setSlackSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setSlackSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4">
            <CredentialField label="Bot Token" value={slackCreds?.botToken} />
            <CredentialField
              label="Signing Secret"
              value={slackCreds?.signingSecret}
            />
            <CredentialField label="App ID" value={slackCreds?.appId} />
          </div>
        </SetupStep>
        <SetupStep
          title="Enable Slack for your Agents and assign channels to them"
          description="Agents with enabled Slack will appear below. Then you can assign channels to them."
          done={hasBindings}
          ctaLabel="Configure"
          onAction={() => setSlackAgentDialogOpen(true)}
        />
      </CollapsibleSetupSection>

      <Divider />

      <AgentTilesSection
        providerConfig={slackProviderConfig}
        onRefreshSuccess={() =>
          queryClient.invalidateQueries({
            queryKey: ["chatops", "bindings"],
          })
        }
      />

      <SlackSetupDialog
        open={slackSetupOpen}
        onOpenChange={setSlackSetupOpen}
      />
      <NgrokSetupDialog
        open={ngrokDialogOpen}
        onOpenChange={setNgrokDialogOpen}
      />
      <SlackAgentSetupDialog
        open={slackAgentDialogOpen}
        onOpenChange={setSlackAgentDialogOpen}
      />
    </div>
  );
}

function NgrokSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [authToken, setAuthToken] = useState("");

  const ngrokCommand = `ngrok http --authtoken=${authToken || "<your-ngrok-auth-token>"} 9000`;
  const envCommand =
    "ARCHESTRA_NGROK_DOMAIN=<your-ngrok-domain>.ngrok-free.dev";

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setStep(1);
      setAuthToken("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>Enter your ngrok auth token</DialogTitle>
              <DialogDescription>
                Get one at{" "}
                <Link
                  href="https://dashboard.ngrok.com/get-started/your-authtoken"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  ngrok.com
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <Input
                placeholder="ngrok auth token"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
              />
              <Button
                className="w-full"
                disabled={!authToken.trim()}
                onClick={() => setStep(2)}
              >
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Run ngrok for Slack webhooks</DialogTitle>
              <DialogDescription>
                Start an ngrok tunnel to make Archestra reachable from Slack.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2 text-sm">
                <p>1. Start an ngrok tunnel:</p>
                <div className="relative">
                  <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto whitespace-pre">
                    {ngrokCommand}
                  </pre>
                  <div className="absolute top-2 right-2">
                    <CopyButton text={ngrokCommand} />
                  </div>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <p>
                  2. Set the ngrok domain in your{" "}
                  <code className="bg-muted px-1 py-0.5 rounded text-xs">
                    .env
                  </code>{" "}
                  file:
                </p>
                <div className="relative">
                  <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto whitespace-pre">
                    {envCommand}
                  </pre>
                  <div className="absolute top-2 right-2">
                    <CopyButton text={envCommand} />
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Then restart Archestra with{" "}
                <code className="bg-muted px-1 py-0.5 rounded">tilt up</code>
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
