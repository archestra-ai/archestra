"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  Grip,
  Info,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { AgentDialog } from "@/components/agent-dialog";
import { CopyButton } from "@/components/copy-button";
import Divider from "@/components/divider";
import { EnableAgentsDialog } from "@/components/enable-agents-dialog";
import { SlackAgentSetupDialog } from "@/components/slack-agent-setup-dialog";
import { SlackSetupDialog } from "@/components/slack-setup-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import {
  useChatOpsBindings,
  useChatOpsStatus,
  useRefreshChatOpsChannelDiscovery,
  useUpdateChatOpsBinding,
} from "@/lib/chatops.query";
import config from "@/lib/config";
import { usePublicBaseUrl } from "@/lib/features.hook";
import { useFeatures } from "@/lib/features.query";
import { cn } from "@/lib/utils";

const DM_ENABLED = false;

export default function SlackPage() {
  const publicBaseUrl = usePublicBaseUrl();
  const [slackSetupOpen, setSlackSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);
  const [slackAgentDialogOpen, setSlackAgentDialogOpen] = useState(false);

  const { data: features } = useFeatures();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const { data: bindings } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });

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

  const localDevOrQuickstartFirstStep = (
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
          needs to be reachable from the Internet. Configure ngrok or deploy to
          a public URL.
        </>
      )}
    </SetupStep>
  );
  const prodFirstStep = (
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
          must be publicly accessible so Slack can deliver events to Archestra
        </span>
      </div>
    </div>
  );
  const firstStep =
    features?.isQuickstart || config.environment === "development"
      ? localDevOrQuickstartFirstStep
      : prodFirstStep;

  return (
    <div className="flex flex-col gap-6">
      {/* Setup Section */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Setup</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Connect Slack so agents can receive and respond to messages.{" "}
            <Link
              href="https://archestra.ai/docs/platform-slack"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Learn more
              <ExternalLink className="h-3 w-3" />
            </Link>
          </p>
        </div>
        {firstStep}
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
          description="Agents with enabled Slack will appear in the table below. Then you can assign channels to them."
          done={hasBindings}
          ctaLabel="Configure"
          onAction={() => setSlackAgentDialogOpen(true)}
        />
      </section>

      <Divider />

      {/* Channel Bindings Section */}
      <ChannelBindingsSection />

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

function ChannelBindingsSection() {
  const { data: bindings, isLoading } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const { data: chatOpsProviders } = useChatOpsStatus();
  const updateMutation = useUpdateChatOpsBinding();
  const queryClient = useQueryClient();
  const refreshMutation = useRefreshChatOpsChannelDiscovery();
  const [enableDialogOpen, setEnableDialogOpen] = useState(false);

  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const slackAgents =
    agents?.filter((a) =>
      Array.isArray(a.allowedChatops)
        ? a.allowedChatops.includes("slack")
        : false,
    ) ?? [];

  const [editingAgent, setEditingAgent] = useState<
    (typeof slackAgents)[number] | null
  >(null);

  const slackBindings = bindings?.filter((b) => b.provider === "slack");

  // Map agentId -> list of bindings
  const bindingsByAgentId = new Map<string, typeof bindings>();
  for (const b of slackBindings ?? []) {
    if (!b.agentId) continue;
    const list = bindingsByAgentId.get(b.agentId) ?? [];
    list.push(b);
    bindingsByAgentId.set(b.agentId, list);
  }

  // Find current user's DM binding (if any).
  // The backend already filters DM bindings to only show the current user's.
  const myDmBinding = slackBindings?.find((b) => b.isDm);

  const handleDmClick = (agentId: string, deepLink: string) => {
    if (myDmBinding && myDmBinding.agentId !== agentId) {
      updateMutation.mutate({ id: myDmBinding.id, agentId });
    }
    window.open(deepLink, "_blank", "noopener,noreferrer");
  };

  // All known channels as MultiSelect items
  const channelItems =
    slackBindings?.map((b) => ({
      value: b.id,
      label: `${b.channelName ?? b.channelId}${b.workspaceName ? ` (${b.workspaceName})` : ""}`,
    })) ?? [];

  const handleChannelsChange = (agentId: string, selectedIds: string[]) => {
    if (!slackBindings) return;

    const currentBindingIds = new Set(
      (bindingsByAgentId.get(agentId) ?? []).map((b) => b.id),
    );

    // Newly added channels: assign this agent
    for (const id of selectedIds) {
      if (!currentBindingIds.has(id)) {
        updateMutation.mutate({ id, agentId });
      }
    }

    // Removed channels: unassign this agent
    const selectedSet = new Set(selectedIds);
    for (const id of currentBindingIds) {
      if (!selectedSet.has(id)) {
        updateMutation.mutate({ id, agentId: null });
      }
    }
  };

  return (
    <section className="flex flex-col gap-4 -mt-2">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Agents ready to chat with</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEnableDialogOpen(true)}
            className="text-xs ml-2"
          >
            <Plus className="h-2 w-2" />
            Add more
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Assign agents to Slack channels using the dropdown below or use{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            /select-agent
          </code>{" "}
          in Slack.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-4">Loading...</p>
      ) : slackAgents.length > 0 ? (
        <div className="rounded-md border [&_[data-slot=table-container]]:overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[20%]">Agent</TableHead>
                <TableHead className="w-[auto]">
                  <div className="flex items-center gap-1">
                    Channels
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-5 w-5"
                            aria-label="Refresh channels"
                            disabled={refreshMutation.isPending}
                            onClick={() =>
                              refreshMutation.mutate("slack", {
                                onSuccess: () =>
                                  queryClient.invalidateQueries({
                                    queryKey: ["chatops", "bindings"],
                                  }),
                              })
                            }
                          >
                            {refreshMutation.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Refresh channels</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </TableHead>
                <TableHead className="w-[160px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slackAgents.map((agent) => {
                const agentBindings = bindingsByAgentId.get(agent.id) ?? [];
                const selectedIds = agentBindings.map((b) => b.id);
                return (
                  <TableRow key={agent.id}>
                    <TableCell className="text-sm font-medium">
                      {agent.name}
                    </TableCell>
                    <TableCell>
                      <MultiSelect
                        value={selectedIds}
                        onValueChange={(ids) =>
                          handleChannelsChange(agent.id, ids)
                        }
                        items={channelItems}
                        placeholder="No channels assigned"
                        disabled={updateMutation.isPending}
                      />
                    </TableCell>
                    <TableCell className="pr-4">
                      <ButtonGroup>
                        {agentBindings.length === 1 && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  aria-label="Open channel in Slack"
                                  asChild
                                >
                                  <a
                                    href={buildSlackDeepLink(agentBindings[0])}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    <Image
                                      src="/icons/slack.png"
                                      alt="Slack"
                                      width={16}
                                      height={16}
                                    />
                                  </a>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                Open channel in Slack
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {agentBindings.length > 1 && (
                          <DropdownMenu>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="outline"
                                      size="icon-sm"
                                      aria-label="Open channel in Slack"
                                    >
                                      <Image
                                        src="/icons/slack.png"
                                        alt="Slack"
                                        width={16}
                                        height={16}
                                      />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Open channel in Slack
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <DropdownMenuContent align="start">
                              {agentBindings.map((b) => (
                                <DropdownMenuItem key={b.id} asChild>
                                  <a
                                    href={buildSlackDeepLink(b)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {b.channelName ?? b.channelId}
                                    {b.workspaceName
                                      ? ` (${b.workspaceName})`
                                      : ""}
                                  </a>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        {DM_ENABLED &&
                          slack?.dmInfo?.botUserId &&
                          slack.dmInfo.teamId && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    aria-label="DM in Slack"
                                    onClick={() =>
                                      handleDmClick(
                                        agent.id,
                                        `slack://user?team=${slack.dmInfo?.teamId}&id=${slack.dmInfo?.botUserId}`,
                                      )
                                    }
                                  >
                                    <Send className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>DM in Slack</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                aria-label="Chat"
                                asChild
                              >
                                <Link href={`/chat/new?agent_id=${agent.id}`}>
                                  <MessageSquare className="h-4 w-4" />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Chat</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                aria-label="Agent Builder"
                                asChild
                              >
                                <Link
                                  href={`/agents/builder?agentId=${agent.id}`}
                                >
                                  <Grip className="h-4 w-4" />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Agent Builder</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                aria-label="Edit"
                                onClick={() => setEditingAgent(agent)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Edit</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </ButtonGroup>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No agents have Slack enabled yet
            </p>
          </CardContent>
        </Card>
      )}

      <EnableAgentsDialog
        open={enableDialogOpen}
        onOpenChange={setEnableDialogOpen}
        provider="slack"
      />

      <AgentDialog
        open={!!editingAgent}
        onOpenChange={(open) => !open && setEditingAgent(null)}
        agent={editingAgent}
        agentType="agent"
      />
    </section>
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

function SetupStep({
  title,
  description,
  done,
  ctaLabel,
  onAction,
  doneActionLabel,
  onDoneAction,
  children,
}: {
  title: string;
  description: string;
  done: boolean;
  ctaLabel: string;
  onAction?: () => void;
  doneActionLabel?: string;
  onDoneAction?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Card className="py-3 gap-0">
      <CardHeader className="px-4 gap-0">
        <div
          className={cn(
            "flex items-center justify-between gap-4",
            children && "pb-2 border-b",
          )}
        >
          <CardTitle>
            <div className="flex items-center gap-4">
              {done ? (
                <CheckCircle2 className="size-5 shrink-0 text-green-500" />
              ) : (
                <Circle className="text-muted-foreground size-5 shrink-0" />
              )}
              <div className="flex flex-col gap-1">
                <div className="font-medium text-sm">{title}</div>
                <div className="text-muted-foreground text-xs font-normal">
                  {description}
                </div>
              </div>
            </div>
          </CardTitle>
          <div className="shrink-0">
            {done && onDoneAction ? (
              <Button
                variant="outline"
                onClick={onDoneAction}
                size="sm"
                className="text-xs"
              >
                {doneActionLabel}
              </Button>
            ) : !done && onAction ? (
              <Button
                variant="outline"
                onClick={onAction}
                size="sm"
                className="text-xs"
              >
                {ctaLabel}
              </Button>
            ) : !done ? (
              <span className="text-muted-foreground text-sm">{ctaLabel}</span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      {children && (
        <CardContent className="text-xs text-muted-foreground px-4 mt-2">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

function buildSlackDeepLink(binding: {
  channelId: string;
  workspaceId?: string | null;
}): string {
  if (binding.workspaceId) {
    return `slack://channel?team=${binding.workspaceId}&id=${binding.channelId}`;
  }
  return `slack://channel?id=${binding.channelId}`;
}

function CredentialField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center gap-0.5">
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        {label}:
      </span>
      <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
        {value || "Not set"}
      </code>
    </div>
  );
}
