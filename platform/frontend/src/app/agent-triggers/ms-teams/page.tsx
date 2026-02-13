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
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AgentDialog } from "@/components/agent-dialog";
import { CopyButton } from "@/components/copy-button";
import { DefaultAgentSetupDialog } from "@/components/default-agent-setup-dialog";
import Divider from "@/components/divider";
import { MsTeamsSetupDialog } from "@/components/ms-teams-setup-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useFeatures } from "@/lib/features.query";
import { cn } from "@/lib/utils";

export default function MsTeamsPage() {
  const [msTeamsSetupOpen, setMsTeamsSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);
  const [defaultAgentDialogOpen, setDefaultAgentDialogOpen] = useState(false);

  const { data: features } = useFeatures();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const { data: bindings } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });

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
    bindings.some((b) => b.agentId && msTeamsAgentIds.has(b.agentId));

  const localDevOrQuickstartFirstStep = (
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
            POST {"<archestra-url>/api/webhooks/chatops/ms-teams"}
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
            POST {"<archestra-url>/api/webhooks/chatops/ms-teams"}
          </code>{" "}
          must be publicly accessible so MS Teams can deliver messages to
          Archestra
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
          <p className="text-sm text-muted-foreground mt-1 text-xs">
            Connect Microsoft Teams so agents can receive and respond to
            messages.{" "}
            <Link
              href="https://archestra.ai/docs/platform-ms-teams"
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
          title="Setup MS Teams"
          description="Register a Teams bot application and connect it to Archestra"
          done={!!msTeams?.configured}
          ctaLabel="Setup MS Teams"
          onAction={() => setMsTeamsSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setMsTeamsSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4 ">
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
          title="Connect Agents to MS Teams channels"
          description="Map your agents to Teams channels — each channel gets its own dedicated agent"
          done={hasBindings}
          ctaLabel="Connect"
          onAction={() => setDefaultAgentDialogOpen(true)}
          doneActionLabel="Connect more"
          onDoneAction={() => setDefaultAgentDialogOpen(true)}
        />
      </section>

      <Divider />

      {/* Channel Bindings Section */}
      <ChannelBindingsSection />

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
    </div>
  );
}

function ChannelBindingsSection() {
  const { data: bindings, isLoading } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const updateMutation = useUpdateChatOpsBinding();
  const refreshMutation = useRefreshChatOpsChannelDiscovery();
  const [refreshDialogOpen, setRefreshDialogOpen] = useState(false);

  const msTeamsAgents =
    agents?.filter((a) =>
      Array.isArray(a.allowedChatops)
        ? a.allowedChatops.includes("ms-teams")
        : false,
    ) ?? [];

  const [editingAgent, setEditingAgent] = useState<
    (typeof msTeamsAgents)[number] | null
  >(null);

  // Map agentId → list of bindings
  const bindingsByAgentId = new Map<string, typeof bindings>();
  for (const b of bindings ?? []) {
    if (!b.agentId) continue;
    const list = bindingsByAgentId.get(b.agentId) ?? [];
    list.push(b);
    bindingsByAgentId.set(b.agentId, list);
  }

  // All known channels as MultiSelect items
  const channelItems =
    bindings?.map((b) => ({
      value: b.id,
      label: `${b.channelName ?? b.channelId}${b.workspaceName ? ` (${b.workspaceName})` : ""}`,
    })) ?? [];

  const handleChannelsChange = (agentId: string, selectedIds: string[]) => {
    if (!bindings) return;

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
        <h2 className="text-lg font-semibold">Agents ready to chat with</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Assign agents to Teams channels using the dropdown below or use{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            /select-agent
          </code>{" "}
          in Teams.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-4">Loading...</p>
      ) : msTeamsAgents.length > 0 ? (
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
                              refreshMutation.mutate("ms-teams", {
                                onSuccess: () => setRefreshDialogOpen(true),
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
              {msTeamsAgents.map((agent) => {
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
                                  aria-label="Open in Teams"
                                  asChild
                                >
                                  <a
                                    href={buildTeamsDeepLink(agentBindings[0])}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    <img
                                      src="/icons/ms-teams.png"
                                      alt="MS Teams"
                                      className="h-4 w-4"
                                    />
                                  </a>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Open in Teams</TooltipContent>
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
                                      aria-label="Open in Teams"
                                    >
                                      <img
                                        src="/icons/ms-teams.png"
                                        alt="MS Teams"
                                        className="h-4 w-4"
                                      />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent>Open in Teams</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <DropdownMenuContent align="start">
                              {agentBindings.map((b) => (
                                <DropdownMenuItem key={b.id} asChild>
                                  <a
                                    href={buildTeamsDeepLink(b)}
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
              No agents have MS Teams enabled yet
            </p>
          </CardContent>
        </Card>
      )}

      <RefreshChannelsDialog
        open={refreshDialogOpen}
        onOpenChange={setRefreshDialogOpen}
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

function RefreshChannelsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setConfirmed(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Channel discovery cache cleared</DialogTitle>
          <DialogDescription>
            The list of channels will be refreshed on the next interaction with
            the Teams bot. Send a message to the bot, then come back and click
            Done.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox
            id="refresh-confirm"
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
          />
          <label htmlFor="refresh-confirm" className="text-sm cursor-pointer">
            I have sent a message to the Teams bot
          </label>
        </div>
        <DialogFooter>
          <Button
            disabled={!confirmed}
            onClick={() => {
              queryClient.invalidateQueries({
                queryKey: ["chatops", "bindings"],
              });
              onOpenChange(false);
              setConfirmed(false);
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

function buildTeamsDeepLink(binding: {
  channelId: string;
  channelName?: string | null;
  workspaceId?: string | null;
}): string {
  const channelName = encodeURIComponent(
    binding.channelName ?? binding.channelId,
  );
  const base = `https://teams.microsoft.com/l/channel/${encodeURIComponent(binding.channelId)}/${channelName}`;
  if (binding.workspaceId) {
    return `${base}?groupId=${encodeURIComponent(binding.workspaceId)}`;
  }
  return base;
}

function CredentialField({
  label,
  value,
  optional,
}: {
  label: string;
  value?: string;
  optional?: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        {label}
        {optional && " (optional)"}:
      </span>
      <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
        {value || "Not set"}
      </code>
    </div>
  );
}
