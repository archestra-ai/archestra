"use client";

import {
  CheckCircle2,
  Circle,
  ExternalLink,
  Info,
  Pencil,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import {
  DefaultAgentSetupDialog,
  StepStartChatting,
} from "@/components/default-agent-setup-dialog";
import Divider from "@/components/divider";
import { MsTeamsSetupDialog } from "@/components/ms-teams-setup-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfiles } from "@/lib/agent.query";
import {
  useChatOpsBindings,
  useChatOpsStatus,
  useDeleteChatOpsBinding,
  useUpdateChatOpsBinding,
} from "@/lib/chatops.query";
import config from "@/lib/config";
import { useFeatures } from "@/lib/features.query";

export default function MsTeamsPage() {
  const [msTeamsSetupOpen, setMsTeamsSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);
  const [defaultAgentDialogOpen, setDefaultAgentDialogOpen] = useState(false);
  const [tryItOutDialogOpen, setTryItOutDialogOpen] = useState(false);

  const { data: features } = useFeatures();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const { data: bindings } = useChatOpsBindings();

  const ngrokDomain = features?.ngrokDomain;

  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");
  const hasBindings = !!bindings && bindings.length > 0;

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
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Archestra's webhook must be reachable from the Internet
        </span>
        <span className="text-muted-foreground">
          The webhook endpoint{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            POST {"<archestra-url>/api/webhooks/chatops/ms-teams"}
          </code>{" "}
          must be publicly accessible so MS Teams can deliver messages to
          Archestra. Deploy to a public URL or configure a tunnel.
        </span>
      </div>
    </div>
  );
  const firstStep =
    features?.isQuickstart || config.environment === "development"
      ? localDevOrQuickstartFirstStep
      : prodFirstStep;

  return (
    <div className="flex flex-col gap-8">
      {/* Setup Section */}
      <section className="flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold">Setup</h2>
          <p className="text-sm text-muted-foreground mt-1">
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
          title="Connect MS Teams"
          description="Allow agents to be triggered via Teams"
          done={!!msTeams?.configured}
          ctaLabel="Setup MS Teams"
          onAction={() => setMsTeamsSetupOpen(true)}
        >
          <p>
            Register a Teams bot application and enter its credentials so
            Archestra can receive and respond to messages.
          </p>
          <div className="flex items-center flex-wrap gap-4 pt-2">
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
            {msTeams?.configured && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7 text-foreground"
                onClick={() => setMsTeamsSetupOpen(true)}
              >
                Reconfigure
              </Button>
            )}
          </div>
        </SetupStep>
        <SetupStep
          title="Setup Agent to work with MS Teams"
          description="Enable MS Teams on your agent and bind it to a channel"
          done={hasBindings}
          ctaLabel="Setup agent"
          onAction={() => setDefaultAgentDialogOpen(true)}
        >
          {hasBindings ? (
            <p>
              {bindings.length} channel{bindings.length === 1 ? "" : "s"} bound
              to agents. View bindings below.
            </p>
          ) : (
            <p>
              Enable MS Teams in your agent&apos;s settings, bind it to Teams
              channel and you are ready to go!
            </p>
          )}
        </SetupStep>

        {hasBindings && (
          <div className="flex items-center justify-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
            <span className="text-sm font-medium text-green-700 dark:text-green-400">
              MS Teams is ready to use
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTryItOutDialogOpen(true)}
            >
              Try it out
            </Button>
          </div>
        )}
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
      <TryItOutDialog
        open={tryItOutDialogOpen}
        onOpenChange={setTryItOutDialogOpen}
      />
    </div>
  );
}

function ChannelBindingsSection() {
  const { data: bindings, isLoading } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const deleteMutation = useDeleteChatOpsBinding();
  const updateMutation = useUpdateChatOpsBinding();

  const [editingBinding, setEditingBinding] = useState<{
    id: string;
    agentId: string | null;
  } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const agentMap = new Map(agents?.map((a) => [a.id, a.name]) ?? []);
  const msTeamsAgents =
    agents?.filter((a) =>
      Array.isArray(a.allowedChatops)
        ? a.allowedChatops.includes("ms-teams")
        : false,
    ) ?? [];

  const handleEdit = (bindingId: string, currentAgentId: string | null) => {
    setEditingBinding({ id: bindingId, agentId: currentAgentId });
  };

  const handleSaveEdit = () => {
    if (!editingBinding) return;
    updateMutation.mutate(
      { id: editingBinding.id, agentId: editingBinding.agentId },
      { onSuccess: () => setEditingBinding(null) },
    );
  };

  const handleDelete = () => {
    if (!deleteConfirmId) return;
    deleteMutation.mutate(deleteConfirmId, {
      onSuccess: () => setDeleteConfirmId(null),
    });
  };

  return (
    <section className="flex flex-col gap-4 -mt-2">
      <div>
        <h2 className="text-lg font-semibold">Channel Bindings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Each Teams channel is bound to an agent that handles incoming messages
          by default. Use{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            /select-agent
          </code>{" "}
          in Teams to create bindings.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-4">
          Loading bindings...
        </p>
      ) : bindings && bindings.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.map((binding) => (
                <TableRow key={binding.id}>
                  <TableCell className="text-sm">
                    {binding.channelName ?? (
                      <span className="font-mono text-xs">
                        {binding.channelId}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {binding.workspaceName ?? (
                      <span className="font-mono text-xs">
                        {binding.workspaceId ?? "—"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {binding.agentId
                      ? (agentMap.get(binding.agentId) ?? "Unknown agent")
                      : "No agent assigned"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          handleEdit(binding.id, binding.agentId ?? null)
                        }
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteConfirmId(binding.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              There are no bindings yet
            </p>
          </CardContent>
        </Card>
      )}

      {/* Edit Dialog */}
      <Dialog
        open={!!editingBinding}
        onOpenChange={(open) => {
          if (!open) setEditingBinding(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Agent Binding</DialogTitle>
            <DialogDescription>
              Choose which agent should handle messages in this channel.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select
              value={editingBinding?.agentId ?? ""}
              onValueChange={(value) =>
                setEditingBinding((prev) =>
                  prev ? { ...prev, agentId: value || null } : null,
                )
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {msTeamsAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingBinding(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={updateMutation.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmId(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Binding</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this channel binding? The channel
              will no longer have a default agent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function TryItOutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[900px] w-[65vw]">
        <DialogHeader>
          <DialogTitle>Try it out</DialogTitle>
          <DialogDescription>
            Your agent is ready. Here are some ideas to get started.
          </DialogDescription>
        </DialogHeader>
        <StepStartChatting showStepHeader={false} />
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
  children,
}: {
  title: string;
  description: string;
  done: boolean;
  ctaLabel: string;
  onAction?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Card className="py-4 gap-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-4 border-b pb-4">
          <CardTitle>
            <div className="flex items-center gap-4">
              {done ? (
                <CheckCircle2 className="size-5 shrink-0 text-green-500" />
              ) : (
                <Circle className="text-muted-foreground size-5 shrink-0" />
              )}
              <div className="flex flex-col gap-1">
                <div className="font-medium">{title}</div>
                <div className="text-muted-foreground text-xs">
                  {description}
                </div>
              </div>
            </div>
          </CardTitle>
          <div className="shrink-0">
            {!done && onAction ? (
              <Button variant="outline" onClick={onAction}>
                {ctaLabel}
              </Button>
            ) : !done ? (
              <span className="text-muted-foreground text-sm">{ctaLabel}</span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2 text-sm text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
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
