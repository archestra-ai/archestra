"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Activity, Bot, CheckCircle2, Plus, Radio, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useA2aRemoteAgentRuns,
  useA2aRemoteAgents,
  useCreateA2aRemoteAgent,
  useDeleteA2aRemoteAgent,
  useInspectA2aRemoteAgent,
} from "@/lib/a2a-remote-agents.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

type DiscoveryMode = "well_known" | "card_url" | "inline_card";
type AuthType = "none" | "bearer" | "api_key";
type RemoteAgent =
  archestraApiTypes.ListA2aRemoteAgentsResponses["200"][number];

export default function OutboundA2aAgentsPage() {
  const query = useA2aRemoteAgents();
  const { data: canManage } = useHasPermissions({
    agentSettings: ["update"],
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RemoteAgent | null>(null);
  const deleteMutation = useDeleteA2aRemoteAgent();

  return (
    <PageLayout
      title="External A2A agents"
      description="Connect Agent2Agent-compatible systems, then assign them from an agent's Subagents section."
      actionButton={
        canManage ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Connect agent
          </Button>
        ) : undefined
      }
    >
      {query.isLoadingError ? (
        <QueryLoadError
          title="External A2A agents could not be loaded"
          description="Retry the connection to load configured external agents."
          onRetry={() => query.refetch()}
        />
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : query.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <Bot className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No external A2A agents connected</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Start with a well-known Agent Card URL or paste a card manually.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {query.data.map((agent) => (
            <Card key={agent.id} className="gap-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Radio className="h-4 w-4" />
                  {agent.name}
                </CardTitle>
                <CardDescription>
                  {agent.description || "External A2A agent"}
                </CardDescription>
                {canManage && (
                  <CardAction>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${agent.name}`}
                      onClick={() => setDeleteTarget(agent)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">A2A 1.x</Badge>
                  <Badge variant="outline">
                    {agent.connection.selectedInterface.protocolBinding}
                  </Badge>
                  <Badge
                    variant={agent.connection.enabled ? "default" : "secondary"}
                  >
                    {agent.connection.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Discovery</dt>
                  <dd className="truncate">
                    {agent.discoveryMode.replaceAll("_", " ")}
                  </dd>
                  <dt className="text-muted-foreground">Authentication</dt>
                  <dd>{agent.connection.authType.replaceAll("_", " ")}</dd>
                  <dt className="text-muted-foreground">Endpoint</dt>
                  <dd
                    className="truncate"
                    title={agent.connection.selectedInterface.url}
                  >
                    {agent.connection.selectedInterface.url}
                  </dd>
                </dl>
                {canManage && <RecentRun remoteAgentId={agent.id} />}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConnectA2aAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Remove external A2A agent?"
        description={
          deleteTarget
            ? `This removes ${deleteTarget.name} and its stored connection credential.`
            : ""
        }
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => setDeleteTarget(null),
          });
        }}
      />
    </PageLayout>
  );
}

function RecentRun({ remoteAgentId }: { remoteAgentId: string }) {
  const query = useA2aRemoteAgentRuns(remoteAgentId);
  const run = query.data?.[0];
  return (
    <div className="flex items-center justify-between gap-3 border-t pt-3 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        Recent activity
      </span>
      {query.isPending ? (
        <span className="text-muted-foreground">Loading…</span>
      ) : query.isError ? (
        <span className="text-destructive">Unavailable</span>
      ) : run ? (
        <span title={new Date(run.startedAt).toLocaleString()}>
          {run.state.replaceAll("_", " ")} ·{" "}
          {new Date(run.startedAt).toLocaleDateString()}
        </span>
      ) : (
        <span className="text-muted-foreground">No runs yet</span>
      )}
    </div>
  );
}

function ConnectA2aAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<DiscoveryMode>("well_known");
  const [url, setUrl] = useState("");
  const [agentCard, setAgentCard] = useState("");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [headerName, setHeaderName] = useState("X-API-Key");
  const [credential, setCredential] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const inspectMutation = useInspectA2aRemoteAgent();
  const createMutation = useCreateA2aRemoteAgent();

  const buildBody = () => {
    let source: archestraApiTypes.InspectA2aRemoteAgentData["body"]["source"];
    if (mode === "inline_card") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(agentCard);
      } catch {
        setParseError("Agent Card must be valid JSON.");
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("Agent Card must be a JSON object.");
        return null;
      }
      source = {
        type: "inline_card",
        agentCard: parsed as Record<string, unknown>,
      };
    } else {
      source = { type: mode, url };
    }
    setParseError(null);
    const auth =
      authType === "none"
        ? ({ type: "none" } as const)
        : authType === "bearer"
          ? ({ type: "bearer", credential } as const)
          : ({ type: "api_key", headerName, credential } as const);
    return { source, auth };
  };

  const reset = () => {
    setMode("well_known");
    setUrl("");
    setAgentCard("");
    setName("");
    setAuthType("none");
    setHeaderName("X-API-Key");
    setCredential("");
    setParseError(null);
    inspectMutation.reset();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Connect external A2A agent"
      description="Discover a protocol endpoint from its Agent Card. Credentials are stored separately from the card."
      size="medium"
    >
      <DialogForm
        onSubmit={(event) => {
          event.preventDefault();
          const body = buildBody();
          if (!body) return;
          createMutation.mutate(
            { ...body, name: name || undefined, connectionName: "Default" },
            {
              onSuccess: () => {
                onOpenChange(false);
                reset();
              },
            },
          );
        }}
      >
        <DialogBody className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="a2a-discovery-mode">Agent Card source</Label>
            <Select
              value={mode}
              onValueChange={(value) => {
                setMode(value as DiscoveryMode);
                inspectMutation.reset();
              }}
            >
              <SelectTrigger id="a2a-discovery-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="well_known">Well-known URL</SelectItem>
                <SelectItem value="card_url">Direct Agent Card URL</SelectItem>
                <SelectItem value="inline_card">
                  Paste Agent Card JSON
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === "inline_card" ? (
            <div className="space-y-2">
              <Label htmlFor="a2a-agent-card">Agent Card JSON</Label>
              <Textarea
                id="a2a-agent-card"
                rows={9}
                value={agentCard}
                onChange={(event) => {
                  setAgentCard(event.target.value);
                  inspectMutation.reset();
                }}
                placeholder='{"name":"My agent", ...}'
                required
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="a2a-url">
                {mode === "well_known" ? "Agent base URL" : "Agent Card URL"}
              </Label>
              <Input
                id="a2a-url"
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  inspectMutation.reset();
                }}
                placeholder="https://agent.example.com"
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="a2a-name">Display name (optional)</Label>
            <Input
              id="a2a-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Uses the Agent Card name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a2a-auth">Authentication</Label>
            <Select
              value={authType}
              onValueChange={(value) => {
                setAuthType(value as AuthType);
                inspectMutation.reset();
              }}
            >
              <SelectTrigger id="a2a-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="api_key">API key header</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {authType === "api_key" && (
            <div className="space-y-2">
              <Label htmlFor="a2a-header">Header name</Label>
              <Input
                id="a2a-header"
                value={headerName}
                onChange={(event) => {
                  setHeaderName(event.target.value);
                  inspectMutation.reset();
                }}
                required
              />
            </div>
          )}
          {authType !== "none" && (
            <div className="space-y-2">
              <Label htmlFor="a2a-credential">Credential</Label>
              <Input
                id="a2a-credential"
                type="password"
                value={credential}
                onChange={(event) => {
                  setCredential(event.target.value);
                  inspectMutation.reset();
                }}
                autoComplete="new-password"
                required
              />
            </div>
          )}
          {parseError && (
            <p role="alert" className="text-sm text-destructive">
              {parseError}
            </p>
          )}
          {inspectMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              The Agent Card could not be reached or validated.
            </p>
          )}
          {inspectMutation.data && (
            <output className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
              <div>
                <p className="font-medium">{inspectMutation.data.name}</p>
                <p className="text-muted-foreground">
                  {inspectMutation.data.selectedInterface.protocolBinding} ·{" "}
                  {inspectMutation.data.selectedInterface.protocolVersion}
                </p>
              </div>
            </output>
          )}
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            disabled={inspectMutation.isPending || createMutation.isPending}
            onClick={() => {
              const body = buildBody();
              if (body) inspectMutation.mutate(body);
            }}
          >
            {inspectMutation.isPending ? "Checking…" : "Validate Agent Card"}
          </Button>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Connecting…" : "Connect agent"}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
