"use client";

// The user's own connected agents: which one they connected last, and the
// Manage dialog to disconnect any of them.

import {
  INSTALLER_CLIENT_FOOTPRINT,
  isOAuthRecognisedClient,
  startupGuardStem,
} from "@archestra/shared/connection-setup";
import { HardDrive, History, Unplug } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type ConnectedClient,
  useConnectedClients,
  useDisconnectConnectedClient,
} from "@/lib/connected-client.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { ClientIcon } from "./client-icon";
import {
  CONNECT_CLIENTS,
  type ConnectClient,
  usesGenericInstructions,
} from "./clients";
import type { ConnectPageData } from "./connect-page-data";
import { fmt, nameOf, plural } from "./connect-page-parts";
import { setupModeFor } from "./manual-setup";
import { detectPlatform } from "./platform.utils";

/** No traffic for this long and the agent reads as idle in Manage. */
const IDLE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A connected agent the Connect page knows how to show. */
export interface ConnectedAgent extends ConnectedClient {
  client: ConnectClient;
}

/**
 * The user's connected agents, newest connect first, and the one marked as
 * last connected: the newest connect we have also seen traffic from. A setup
 * that never made a gateway or LLM proxy call may have failed or been
 * removed, so it is never the one marked. A failed read shows nothing.
 */
export function useConnectedAgents(): {
  agents: ConnectedAgent[];
  lastConnected: ConnectedAgent | null;
} {
  const { data } = useConnectedClients();
  const agents = (data ?? []).flatMap((record) => {
    const client = CONNECT_CLIENTS.find((c) => c.id === record.clientId);
    return client ? [{ ...record, client }] : [];
  });
  return {
    agents,
    lastConnected: agents.find((a) => a.lastSeenAt !== null) ?? null,
  };
}

/** The small mark on the last connected agent, with when it was. */
export function LastConnectedMark({
  agent,
  className,
}: {
  agent: ConnectedAgent;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label="Last connected"
          className={cn(
            "grid size-5 place-items-center rounded-full border bg-background text-muted-foreground",
            className,
          )}
        >
          <History className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {`Last connected ${formatRelativeTimeFromNow(agent.lastConnectedAt)}`}
        {agent.lastSeenAt
          ? ` · active ${formatRelativeTimeFromNow(agent.lastSeenAt)}`
          : ""}
      </TooltipContent>
    </Tooltip>
  );
}

/** "Manage" next to the picker: the connected agents, one disconnect each. */
export function ManageAgents({
  data,
  agents,
}: {
  data: ConnectPageData;
  agents: ConnectedAgent[];
}) {
  const [open, setOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState<ConnectedAgent | null>(
    null,
  );
  // Revoking drops the agent from the list, which closes its dialog.
  const current = disconnecting
    ? (agents.find((a) => a.clientId === disconnecting.clientId) ?? null)
    : null;
  if (agents.length === 0) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        {`${agents.length} connected · Manage`}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader className="px-4">
            <DialogTitle>Connected agents</DialogTitle>
            <DialogDescription>
              Agents you connected from this page or signed in to the gateway.
              Disconnecting one leaves the others as they are.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-lg border">
              {agents.map((agent) => (
                <li
                  key={agent.clientId}
                  className="flex items-center gap-3 py-2 pr-2 pl-3"
                >
                  <ClientIcon client={agent.client} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {agent.client.label}
                    </div>
                    <div
                      className="truncate text-xs text-muted-foreground"
                      title={agent.deviceNames.join(", ") || undefined}
                    >
                      {`Connected ${formatRelativeTimeFromNow(agent.lastConnectedAt)}`}
                      {agent.deviceNames.length > 0
                        ? ` on ${agent.deviceNames.join(", ")}`
                        : ""}
                    </div>
                    <ActivityLine agent={agent} />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setOpen(false);
                      setDisconnecting(agent);
                    }}
                  >
                    <Unplug />
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          </DialogBody>
        </DialogContent>
      </Dialog>
      <DisconnectDialog
        data={data}
        agent={current}
        onOpenChange={(v) => !v && setDisconnecting(null)}
      />
    </>
  );
}

/**
 * When we last saw the agent's traffic. No traffic is said as such: the
 * setup may have failed or been removed on the machine, and only the user
 * can tell.
 */
function ActivityLine({ agent }: { agent: ConnectedAgent }) {
  const idle =
    !agent.lastSeenAt ||
    Date.now() - new Date(agent.lastSeenAt).getTime() > IDLE_DAYS * DAY_MS;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs",
        idle ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          idle ? "bg-amber-500" : "bg-emerald-500",
        )}
      />
      <span className="truncate">
        {agent.lastSeenAt
          ? idle
            ? `No activity in ${IDLE_DAYS} days, last ${formatRelativeTimeFromNow(agent.lastSeenAt)}`
            : `Active ${formatRelativeTimeFromNow(agent.lastSeenAt)}`
          : "No activity in the last 30 days"}
      </span>
    </div>
  );
}

// === Disconnect: clean up the machine, then revoke access ===

function DisconnectDialog({
  data,
  agent,
  onOpenChange,
}: {
  data: ConnectPageData;
  agent: ConnectedAgent | null;
  onOpenChange: (v: boolean) => void;
}) {
  const disconnect = useDisconnectConnectedClient();
  const client = agent?.client;
  return (
    <Dialog open={!!agent} onOpenChange={onOpenChange}>
      {agent && client && (
        <DialogContent className="max-w-lg">
          <DialogHeader className="px-4">
            <DialogTitle className="flex items-center gap-2.5">
              <ClientIcon client={client} size={22} />
              Disconnect {client.label}
            </DialogTitle>
            <DialogDescription>Two steps, in this order.</DialogDescription>
          </DialogHeader>
          <DisconnectSteps
            data={data}
            client={client}
            revoke={
              <div className="space-y-3">
                <p className="text-muted-foreground">
                  Once the cleanup is done, revoke access.{" "}
                  <RevokeEffect client={client} />
                </p>
                {agent.deviceNames.length > 1 && (
                  <p className="text-muted-foreground">
                    Connected on {agent.deviceNames.join(", ")}. Revoking cuts
                    all of them; run the cleanup prompt on each.
                  </p>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate(agent.clientId)}
                >
                  <Unplug />
                  <span>Revoke access</span>
                </Button>
              </div>
            }
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** What Revoke access does. */
function RevokeEffect({ client }: { client: ConnectClient }) {
  // Only agents the gateway can tell apart by their OAuth client lose their
  // sign-in; the rest keep it until it expires.
  return isOAuthRecognisedClient(client.id) ? (
    <span>
      Revoke access removes {nameOf(client)} from this list, signs it out of the
      gateway, and revokes the skill links it created. The cleanup prompt
      removes access on the machine.
    </span>
  ) : (
    <span>
      Revoke access removes {nameOf(client)} from this list and revokes the
      skill links it created. Its gateway sign-in lasts until it expires; the
      cleanup prompt removes access on the machine.
    </span>
  );
}

/** What the setup added to this agent, and the prompt that removes it. */
function DisconnectSteps({
  data,
  client,
  revoke,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  /** Step 2's body: the button that revokes access. */
  revoke: ReactNode;
}) {
  const manualOnly = setupModeFor(client) === "manual";
  const skills = data.footprintFor(client).skillsInstalled;
  const guard = startupGuardStem(client.id);
  const [origin, setOrigin] = useState("");
  const [windows, setWindows] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    setWindows(detectPlatform() === "windows");
  }, []);
  const local = [
    ...(skills > 0 ? [`${fmt(skills)} ${plural(skills, "skill")}`] : []),
    ...((INSTALLER_CLIENT_FOOTPRINT as Record<string, string[]>)[client.id] ??
      (client.id === "n8n"
        ? ["The MCP Client Tool node you added in n8n"]
        : [`The ${data.appName} MCP entry in your agent's config`])),
  ];
  const cleanup = (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
        <HardDrive />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            On your machine, in {nameOf(client)}
          </div>
          <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
            {local.map((l) => (
              <li key={l} className="truncate">
                {l}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-muted-foreground">
          {manualOnly
            ? `In ${nameOf(client)}, delete the MCP Client Tool node you added.`
            : `Paste this into ${nameOf(client)} to remove it:`}
        </p>
        {!manualOnly && (
          <CopyPrompt text={disconnectPrompt(data, client, origin)} />
        )}
      </div>
      {!manualOnly && guard && (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            If {nameOf(client)}
            {` won't run it, run this in a terminal yourself (${windows ? "Windows PowerShell" : "macOS or Linux"}):`}
          </p>
          <CopyPrompt
            text={
              windows
                ? `$env:ARCHESTRA_GUARD_ACTION='disconnect'; try { & "$HOME\\.archestra\\${guard}-startup-guard.ps1" } finally { Remove-Item Env:ARCHESTRA_GUARD_ACTION }`
                : `ARCHESTRA_GUARD_ACTION=disconnect bash ~/.archestra/${guard}-startup-guard.sh`
            }
          />
        </div>
      )}
    </div>
  );
  const steps = [
    { title: "Clean up this computer", body: cleanup },
    { title: "Revoke access", body: revoke },
  ];
  return (
    <DialogBody className="text-sm">
      <ol className="flex flex-col">
        {steps.map((step, i) => (
          <li
            key={step.title}
            className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 pb-6 last:pb-0"
          >
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className="absolute top-8 bottom-1 left-[0.875rem] w-px bg-border"
              />
            )}
            <span className="grid size-7 place-items-center rounded-full border bg-background text-xs tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0">
              <h3 className="pt-1 font-medium">{step.title}</h3>
              <div className="mt-2 min-w-0">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>
    </DialogBody>
  );
}

/**
 * The cleanup prompt: disconnect.md removes what connect.md set up. Apps with
 * an installer get their own steps, other agents the generic ones; both point
 * at the base the setup wrote when it isn't this page's own.
 */
function disconnectPrompt(
  data: ConnectPageData,
  client: ConnectClient,
  origin: string,
) {
  const params = new URLSearchParams({
    client: usesGenericInstructions(client) ? "generic" : client.id,
  });
  if (data.baseUrl !== `${origin}/v1`) params.set("base", data.baseUrl);
  return `Read ${origin}/disconnect.md?${decodeURIComponent(params.toString())} and disconnect ${client.label} from ${data.appName}.`;
}

/** The text gets the width; the copy is one icon. */
function CopyPrompt({ text }: { text: string }) {
  return (
    <div className="relative rounded-lg border bg-muted/40 py-2.5 pr-11 pl-3">
      <code className="block font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </code>
      <CopyButton text={text} className="absolute top-1.5 right-1.5" />
    </div>
  );
}
