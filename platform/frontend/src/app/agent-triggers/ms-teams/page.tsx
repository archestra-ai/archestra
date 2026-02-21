"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DefaultAgentSetupDialog } from "@/components/default-agent-setup-dialog";
import Divider from "@/components/divider";
import { MsTeamsSetupDialog } from "@/components/ms-teams-setup-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const msTeamsProviderConfig: ProviderConfig = {
  provider: "ms-teams",
  providerLabel: "MS Teams",
  providerIcon: "/icons/ms-teams.png",
  webhookPath: "/api/webhooks/chatops/ms-teams",
  docsUrl: "https://archestra.ai/docs/platform-ms-teams",
  slashCommand: "/archestra-select-agent",
  buildDeepLink: (binding) => {
    const channelName = encodeURIComponent(
      binding.channelName ?? binding.channelId,
    );
    const base = `https://teams.microsoft.com/l/channel/${encodeURIComponent(binding.channelId)}/${channelName}`;
    if (binding.workspaceId) {
      return `${base}?groupId=${encodeURIComponent(binding.workspaceId)}`;
    }
    return base;
  },
  getDmDeepLink: (providerStatus) => {
    const appId = providerStatus.dmInfo?.appId;
    if (!appId) return null;
    return `https://teams.microsoft.com/l/chat/0/0?users=28:${appId}`;
  },
};

export default function MsTeamsPage() {
  const publicBaseUrl = usePublicBaseUrl();
  const [msTeamsSetupOpen, setMsTeamsSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);
  const [defaultAgentDialogOpen, setDefaultAgentDialogOpen] = useState(false);
  const [refreshDialogOpen, setRefreshDialogOpen] = useState(false);

  const { data: features, isLoading: featuresLoading } = useFeatures();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();
  const { data: bindings, isLoading: bindingsLoading } = useChatOpsBindings();
  const { data: agents, isLoading: agentsLoading } = useProfiles({
    filters: { agentType: "agent" },
  });

  const ngrokDomain = features?.ngrokDomain;
  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");

  const msTeamsAgentIds = new Set(
    agents
      ?.filter((a) =>
        Array.isArray(a.allowedChatops)
          ? a.allowedChatops.includes("ms-teams")
          : false,
      )
      .map((a) => a.id) ?? [],
  );
  const hasBindings =
    !!bindings &&
    bindings.some(
      (b) =>
        b.provider === "ms-teams" &&
        !b.isDm &&
        b.agentId &&
        msTeamsAgentIds.has(b.agentId),
    );

  const setupDataLoading =
    featuresLoading || statusLoading || bindingsLoading || agentsLoading;
  const isLocalDev =
    features?.isQuickstart || config.environment === "development";
  const allStepsCompleted = isLocalDev
    ? !!ngrokDomain && !!msTeams?.configured && hasBindings
    : !!msTeams?.configured && hasBindings;

  return (
    <div className="flex flex-col gap-6">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={setupDataLoading}
        providerLabel="Microsoft Teams"
        docsUrl="https://archestra.ai/docs/platform-ms-teams"
      >
        {isLocalDev ? (
          <SetupStep
            title="Make Archestra reachable from the Internet"
            description="The MS Teams bot needs to connect to an Archestra webhook — your instance must be publicly accessible"
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
                  POST {`${publicBaseUrl}/api/webhooks/chatops/ms-teams`}
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
                  POST {`${publicBaseUrl}/api/webhooks/chatops/ms-teams`}
                </code>{" "}
                must be publicly accessible so MS Teams can deliver messages to
                Archestra
              </span>
            </div>
          </div>
        )}
        <SetupStep
          title="Setup MS Teams"
          description="Register a Teams bot application and connect it to Archestra"
          done={!!msTeams?.configured}
          ctaLabel="Setup MS Teams"
          onAction={() => setMsTeamsSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setMsTeamsSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4">
            <CredentialField
              label="App ID"
              value={msTeams?.credentials?.appId}
            />
            <CredentialField
              label="App Secret"
              value={msTeams?.credentials?.appSecret}
            />
            <CredentialField
              label="Tenant ID"
              value={msTeams?.credentials?.tenantId}
              optional
            />
          </div>
        </SetupStep>
        <SetupStep
          title="Enable MS Teams for your Agents and assign channels to them"
          description="Agents with enabled MS Teams will appear below. Then you can assign channels to them."
          done={hasBindings}
          ctaLabel="Configure"
          onAction={() => setDefaultAgentDialogOpen(true)}
        />
      </CollapsibleSetupSection>

      <Divider />

      <AgentTilesSection
        providerConfig={msTeamsProviderConfig}
        onRefreshSuccess={() => setRefreshDialogOpen(true)}
      />

      <MsTeamsSetupDialog
        open={msTeamsSetupOpen}
        onOpenChange={setMsTeamsSetupOpen}
      />
      <NgrokSetupDialog
        open={ngrokDialogOpen}
        onOpenChange={setNgrokDialogOpen}
      />
      <DefaultAgentSetupDialog
        open={defaultAgentDialogOpen}
        onOpenChange={setDefaultAgentDialogOpen}
      />
      <RefreshChannelsDialog
        open={refreshDialogOpen}
        onOpenChange={setRefreshDialogOpen}
      />
    </div>
  );
}

function RefreshChannelsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Channel discovery</DialogTitle>
          <DialogDescription>
            In order to finish the channel discovery process, you need to send a
            message to the bot in MS Teams.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            onClick={() => {
              queryClient.invalidateQueries({
                queryKey: ["chatops", "bindings"],
              });
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  const dockerCommand = `docker run -p 9000:9000 -p 3000:3000 \\
  -e ARCHESTRA_QUICKSTART=true \\
  -e ARCHESTRA_NGROK_AUTH_TOKEN=${authToken || "<your-ngrok-auth-token>"} \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v archestra-postgres-data:/var/lib/postgresql/data \\
  -v archestra-app-data:/app/data \\
  archestra/platform`;

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
              <DialogTitle>Run Archestra with ngrok</DialogTitle>
              <DialogDescription>
                Choose how you want to set up ngrok with Archestra.
              </DialogDescription>
            </DialogHeader>
            <Tabs defaultValue="docker">
              <TabsList className="w-full">
                <TabsTrigger value="docker">Docker</TabsTrigger>
                <TabsTrigger value="local">Local Development</TabsTrigger>
              </TabsList>
              <TabsContent value="docker" className="space-y-3 pt-2">
                <p className="text-xs text-muted-foreground">
                  Restart Archestra using the following command to enable ngrok:
                </p>
                <div className="relative">
                  <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto whitespace-pre">
                    {dockerCommand}
                  </pre>
                  <div className="absolute top-2 right-2">
                    <CopyButton text={dockerCommand} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Then open{" "}
                  <code className="bg-muted px-1 py-0.5 rounded">
                    localhost:3000
                  </code>
                </p>
              </TabsContent>
              <TabsContent value="local" className="space-y-3 pt-2">
                <div className="space-y-2 text-sm">
                  <p>
                    1. Start an ngrok tunnel pointing to your local Archestra
                    instance:
                  </p>
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
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
