"use client";

// The user's own connected agents: which one they connected last, the
// Manage dialog to disconnect any of them, and how disconnecting works
// before anything is connected.

import {
  INSTALLER_CLIENT_FOOTPRINT,
  revokeSignsOut,
  startupGuardStem,
} from "@archestra/shared/connection-setup";
import { ChevronDown, History, Unplug } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
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
import {
  agentsInPickerOrder,
  fmt,
  nameOf,
  plural,
  TextButton,
} from "./connect-page-parts";
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
  const agents = (data ?? []).map((record) => ({
    ...record,
    client: connectClientOf(record),
  }));
  return {
    agents,
    lastConnected: agents.find((a) => a.lastSeenAt !== null) ?? null,
  };
}

/**
 * The Connect page app a connected agent is. One no app lists, known only
 * from its gateway sign-in, shows under the name it registered, with the
 * generic client's instructions and an initial for its logo.
 */
function connectClientOf(record: ConnectedClient): ConnectClient {
  const listed = CONNECT_CLIENTS.find((c) => c.id === record.clientId);
  if (listed) return listed;
  return {
    ...GENERIC_CLIENT,
    id: record.clientId,
    label: record.name,
    sub: "Signed in to the gateway",
    iconOverride: {
      ...GENERIC_CLIENT.iconOverride,
      glyph: record.name.trim().charAt(0).toUpperCase() || "?",
    },
  };
}

const GENERIC_CLIENT = (() => {
  const generic = CONNECT_CLIENTS.find((c) => c.id === "generic");
  if (!generic?.iconOverride) throw new Error("Generic client is missing");
  return { ...generic, iconOverride: generic.iconOverride };
})();

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
  onHowItWorks,
}: {
  data: ConnectPageData;
  agents: ConnectedAgent[];
  /** Opens How to disconnect, for an agent not connected yet. */
  onHowItWorks?: () => void;
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
      <TextButton onClick={() => setOpen(true)}>Manage</TextButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader className="px-4">
            <DialogTitle>Manage connected agents</DialogTitle>
            <DialogDescription className="sr-only">
              Your connected agents, with a way to disconnect each.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="mb-3 text-sm text-muted-foreground">
              Agents you connected from this page or signed in to the gateway.
              Disconnecting one leaves the others as they are.
            </p>
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
            {onHowItWorks && (
              <p className="mt-3 text-xs text-muted-foreground">
                Disconnecting an agent you haven't connected yet?{" "}
                <TextButton
                  onClick={() => {
                    setOpen(false);
                    onHowItWorks();
                  }}
                >
                  How it works
                </TextButton>
              </p>
            )}
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

// === Before connecting: how a connection comes off again ===

/**
 * Beside the picker: that a connection comes off again, then one link. With
 * nothing connected it opens How to disconnect; once something is, Manage
 * opens the connected agents, which link to How to disconnect themselves.
 */
export function DisconnectLine({
  data,
  picked,
  agents,
}: {
  data: ConnectPageData;
  /** The agent picked on the page; How to disconnect opens on it. */
  picked: ConnectClient;
  agents: ConnectedAgent[];
}) {
  const [howTo, setHowTo] = useState(false);
  return (
    <span className="text-xs text-muted-foreground">
      You can disconnect at any time ·{" "}
      {agents.length === 0 ? (
        <TextButton onClick={() => setHowTo(true)}>How it works</TextButton>
      ) : (
        <>
          {fmt(agents.length)} connected ·{" "}
          <ManageAgents
            data={data}
            agents={agents}
            onHowItWorks={() => setHowTo(true)}
          />
        </>
      )}
      <HowToDisconnect
        data={data}
        picked={picked}
        open={howTo}
        onOpenChange={setHowTo}
      />
    </span>
  );
}

/**
 * How disconnecting works, for any agent. It opens on the agent picked on the
 * page and lists the same agents as the picker; its own selector switches it,
 * so what it shows never changes behind the user's back.
 */
function HowToDisconnect({
  data,
  picked,
  open,
  onOpenChange,
}: {
  data: ConnectPageData;
  picked: ConnectClient;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState(picked.id);
  // Each opening starts again from the page's pick.
  useEffect(() => {
    if (open) setSelectedId(picked.id);
  }, [open, picked.id]);
  const options = agentsInPickerOrder(data);
  const client = options.find((c) => c.id === selectedId) ?? picked;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="px-4">
          <DialogTitle>Disconnecting an agent</DialogTitle>
          <DialogDescription className="sr-only">
            How to remove an agent's connection to {data.appName}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2.5 px-4 pt-4 text-sm">
          <span className="text-muted-foreground">Show steps for</span>
          <Select value={client.id} onValueChange={setSelectedId}>
            {/* Wide enough for the longest agent name, and the list opens
                below it rather than over the text. */}
            <SelectTrigger
              size="sm"
              aria-label="Show steps for"
              className="min-w-56"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className="max-h-80">
              {options.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <ClientIcon client={c} size={16} />
                    {c.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DisconnectSteps
          // The details fold resets per agent.
          key={client.id}
          data={data}
          client={client}
          revoke={
            <p className="text-muted-foreground">
              Once it's connected, open Manage on this page, press Disconnect,
              then Revoke access.
            </p>
          }
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What Revoke access does. */
function RevokeEffect({ client }: { client: ConnectClient }) {
  // Agents signed in to the gateway lose their sign-in; a setup-only agent
  // keeps any it has until it expires.
  return revokeSignsOut(client.id) ? (
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
  /** Step 2's body: how, or the button, to revoke access. */
  revoke: ReactNode | null;
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
    ...(revoke ? [{ title: "Revoke access", body: revoke }] : []),
  ];
  // First what disconnecting does, then how.
  // The list of what's removed stays folded until asked for.
  const [details, setDetails] = useState(false);
  const preamble = (
    <div className="mb-5 space-y-2.5">
      <p className="text-muted-foreground">
        Disconnecting removes what the setup added to {nameOf(client)} on this
        computer
        {revoke ? `, then revokes its access to ${data.appName}` : ""}.
      </p>
      {/* The toggle and the list it opens are one block. */}
      <div className="rounded-lg border bg-muted/30 text-xs">
        <UnstyledButton
          type="button"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {details ? "Hide details" : "Show details"}
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform",
              details && "rotate-180",
            )}
          />
        </UnstyledButton>
        {details && (
          <ul className="list-disc space-y-0.5 border-t px-3 py-2 pl-7 text-muted-foreground">
            {local.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
  // One step needs no numbers.
  if (steps.length === 1)
    return (
      <DialogBody className="text-sm">
        {preamble}
        <h3 className="font-medium">{steps[0].title}</h3>
        <div className="mt-2 min-w-0">{steps[0].body}</div>
      </DialogBody>
    );
  return (
    <DialogBody className="text-sm">
      {preamble}
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
  // Generic client: the prompt for whichever agent reads it.
  const any = client.id === "generic";
  const params = new URLSearchParams(
    any
      ? {}
      : { client: usesGenericInstructions(client) ? "generic" : client.id },
  );
  if (data.baseUrl !== `${origin}/v1`) params.set("base", data.baseUrl);
  const query = params.size ? `?${decodeURIComponent(params.toString())}` : "";
  return `Read ${origin}/disconnect.md${query} and disconnect ${any ? "this agent" : client.label} from ${data.appName}.`;
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
