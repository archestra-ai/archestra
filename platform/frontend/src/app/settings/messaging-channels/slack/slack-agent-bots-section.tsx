"use client";

import {
  type archestraApiTypes,
  SLACK_BOT_HANDLE_PATTERN,
  slackHandleFor,
} from "@archestra/shared";
import {
  ArrowUpRight,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { SlackSetupDialog } from "@/components/slack-setup-dialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SecretInput } from "@/components/ui/secret-input";
import { useInternalAgents } from "@/lib/agent.query";
import {
  useConvertSlackAppToAgentBot,
  useCreateSlackAgentBotApp,
  useDeleteSlackAgentBot,
  useMigrateSlackApps,
  useSaveSlackAppConfigToken,
  useSlackAgentBots,
  useUpdateSlackAgentBot,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

type ConnectionMode = "socket" | "webhook";

/**
 * Slack, set up as one bot per agent. Each bot is its own Slack app that
 * always answers as its agent, so people @mention the agent by name — several
 * can share a channel and a thread. With a Slack app configuration token saved,
 * Archestra creates each app itself.
 */
export function SlackAgentBotsSection({
  connectionMode,
  connectionModeSettings,
}: {
  connectionMode: ConnectionMode;
  /** The connection-mode chooser, shown under Advanced (a rare setting). */
  connectionModeSettings: React.ReactNode;
}) {
  const appName = useAppName();
  const { data, isLoading, refetch, isFetching } = useSlackAgentBots();
  const bots = data?.bots ?? [];
  const canCreateApps = data?.canCreateApps ?? false;
  const { data: agents = [] } = useInternalAgents();
  const deleteMutation = useDeleteSlackAgentBot();

  const [connectOpen, setConnectOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [manualAgent, setManualAgent] = useState<AgentRef | null>(null);
  const [finishBot, setFinishBot] = useState<FinishTarget | null>(null);
  const [removeBot, setRemoveBot] = useState<AgentRef | null>(null);

  useInstallResultToast();

  const agentsWithoutBot = agents.filter(
    (agent) => !bots.some((bot) => bot.agentId === agent.id),
  );
  const isEmpty = !isLoading && bots.length === 0 && !data?.unassignedApp;

  const openFinish = (bot: AgentBot) =>
    setFinishBot({
      id: bot.agentId,
      name: bot.agentName,
      appId: bot.appId,
      needsBotToken: !bot.installed,
      needsAppLevelToken: bot.needsAppLevelToken,
    });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">Slack</h2>
          <p className="text-sm text-muted-foreground">
            {bots.length > 0 ? (
              <span>
                {data?.workspaceName ? (
                  <span>
                    Workspace{" "}
                    <span className="font-medium text-foreground">
                      {data.workspaceName}
                    </span>{" "}
                    ·{" "}
                  </span>
                ) : null}
                {bots.length} {bots.length === 1 ? "bot" : "bots"}
              </span>
            ) : (
              <span>Not connected yet</span>
            )}
          </p>
        </div>
        {!isEmpty && (
          <Button
            size="sm"
            onClick={() =>
              canCreateApps ? setAddOpen(true) : setConnectOpen(true)
            }
          >
            <Plus />
            <span>Add Slack bot</span>
          </Button>
        )}
      </div>

      {!isLoading && data?.unassignedApp && (
        <ConvertAppCard app={data.unassignedApp} agents={agentsWithoutBot} />
      )}

      {isEmpty && (
        <div className="flex min-h-[420px] items-center justify-center rounded-xl border bg-card p-12">
          <div className="flex max-w-[520px] flex-col items-center gap-5 text-center">
            <div className="flex gap-2">
              <HandleChip
                handle={slackHandleFor(appName, "marketing")}
                tone={0}
              />
              <HandleChip handle={slackHandleFor(appName, "coding")} tone={2} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-xl font-semibold">
                Give each agent its own Slack bot
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                People @mention an agent by name, in any channel — several
                agents can share one channel and one thread. Each bot streams
                its answers and has a Stop button.
              </p>
            </div>
            <Button
              onClick={() =>
                canCreateApps ? setAddOpen(true) : setConnectOpen(true)
              }
            >
              {canCreateApps ? (
                <span>Add Slack bot</span>
              ) : (
                <span>Connect Slack</span>
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              Takes about a minute. You paste one token from Slack; {appName}{" "}
              creates the apps.
            </p>
          </div>
        </div>
      )}

      {bots.length > 0 && (
        <div className="@container overflow-hidden rounded-xl border bg-card">
          <div className="hidden gap-4 border-b px-5 py-2.5 text-xs font-medium text-muted-foreground @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_200px_150px_auto]">
            <div>Bot</div>
            <div>Agent</div>
            <div>Status</div>
            <div />
          </div>
          {bots.map((bot, index) => (
            <div key={bot.agentId} className="border-b last:border-b-0">
              {/* Narrow: the handle gets its own line, agent and status below it. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_200px_150px_auto]">
                <div className="flex min-w-0 basis-full items-center gap-3 @3xl:basis-auto">
                  <BotAvatar
                    handle={
                      bot.handle ?? slackHandleFor(appName, bot.agentName)
                    }
                    tone={index}
                    icon={
                      agents.find((agent) => agent.id === bot.agentId)?.icon
                    }
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-mono text-sm font-medium">
                      @{bot.handle ?? slackHandleFor(appName, bot.agentName)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {bot.installed ? (
                        <span>
                          {bot.connectionMode === "socket"
                            ? "Socket Mode"
                            : "Webhook"}{" "}
                          · {bot.appId}
                        </span>
                      ) : (
                        <span>
                          {bot.createdByArchestra
                            ? `Created by ${appName}`
                            : bot.appId}{" "}
                          · not installed yet
                        </span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="truncate pl-12 text-sm @3xl:pl-0">
                  {bot.agentName}
                </div>
                <BotStatus bot={bot} />
                <div className="ml-auto flex justify-end gap-2 @3xl:ml-0">
                  {(!bot.installed || bot.needsAppLevelToken) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openFinish(bot)}
                    >
                      Finish setup
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label={`More actions for @${bot.handle ?? bot.agentName}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <a
                          href={`https://api.slack.com/apps/${bot.appId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open in Slack
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() =>
                          setRemoveBot({
                            id: bot.agentId,
                            name: bot.handle ? `@${bot.handle}` : bot.agentName,
                          })
                        }
                      >
                        Remove bot
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {bot.identitySyncError && (
                <p className="mx-5 mb-4 text-xs text-amber-800 @3xl:ml-[68px] dark:text-amber-300">
                  Slack did not take the agent's latest name or icon:{" "}
                  {bot.identitySyncError}
                </p>
              )}
              {bot.installed && bot.reinstallUrl && (
                <ReinstallRow
                  reinstallUrl={bot.reinstallUrl}
                  missingScopes={bot.missingScopes}
                  checking={isFetching}
                  onCheckAgain={() => refetch()}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <AdvancedSettings
        canCreateApps={canCreateApps}
        onReplaceToken={() => setConnectOpen(true)}
        connectionModeSettings={connectionModeSettings}
      />

      {connectOpen && (
        <ConnectSlackDialog
          replacing={canCreateApps}
          onClose={() => setConnectOpen(false)}
          onConnected={() => {
            setConnectOpen(false);
            if (bots.length === 0 && !data?.unassignedApp) setAddOpen(true);
          }}
        />
      )}

      {addOpen && (
        <AddBotDialog
          agents={agentsWithoutBot}
          connectionMode={connectionMode}
          onClose={() => setAddOpen(false)}
          onManual={(agent) => {
            setAddOpen(false);
            setManualAgent(agent);
          }}
          onNeedsTokens={(target) => {
            setAddOpen(false);
            setFinishBot(target);
          }}
        />
      )}

      {manualAgent && (
        <SlackSetupDialog
          key={manualAgent.id}
          open
          onOpenChange={(open) => {
            if (!open) setManualAgent(null);
          }}
          connectionMode={connectionMode}
          agent={manualAgent}
        />
      )}

      {finishBot && (
        <FinishSetupDialog
          key={finishBot.id}
          target={finishBot}
          onClose={() => setFinishBot(null)}
        />
      )}

      <DeleteConfirmDialog
        open={removeBot !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveBot(null);
        }}
        title="Remove Slack bot"
        description={`${removeBot?.name ?? "This bot"} stops answering in Slack. A Slack app ${appName} created or manages is deleted from Slack too.`}
        isPending={deleteMutation.isPending}
        confirmLabel="Remove"
        pendingLabel="Removing..."
        onConfirm={async () => {
          if (!removeBot) return;
          await deleteMutation.mutateAsync(removeBot.id);
          setRemoveBot(null);
        }}
      />
    </section>
  );
}

// =============================================================================
// Internal Components
// =============================================================================

type AgentRef = { id: string; name: string; icon?: string | null };

type AgentBot =
  archestraApiTypes.ListSlackAgentBotsResponses["200"]["bots"][number];

type UnassignedApp = NonNullable<
  archestraApiTypes.ListSlackAgentBotsResponses["200"]["unassignedApp"]
>;

type FinishTarget = AgentRef & {
  appId: string;
  needsBotToken: boolean;
  needsAppLevelToken: boolean;
};

/** Soft tints that tell bots apart at a glance; text stays readable on each. */
const TONES = [
  "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
];

function toneFor(index: number): string {
  return TONES[index % TONES.length];
}

/** The agent's image icon — Slack shows the same one — else initials. */
function BotAvatar({
  handle,
  tone,
  icon,
}: {
  handle: string;
  tone: number;
  icon?: string | null;
}) {
  if (icon?.startsWith("data:image/")) {
    return (
      <div
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted"
      >
        <AgentIcon icon={icon} size={36} />
      </div>
    );
  }
  const initials = handle
    .split(/[_\-.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
        toneFor(tone),
      )}
    >
      {initials || "@"}
    </div>
  );
}

function HandleChip({ handle, tone }: { handle: string; tone: number }) {
  return (
    <span
      className={cn(
        "rounded-lg px-2.5 py-1.5 font-mono text-sm font-medium",
        toneFor(tone),
      )}
    >
      @{handle}
    </span>
  );
}

function BotStatus({ bot }: { bot: AgentBot }) {
  const status = !bot.installed
    ? { label: "Not installed", dot: "border-[1.5px] border-muted-foreground" }
    : bot.needsAppLevelToken
      ? { label: "Needs app-level token", dot: "bg-amber-600", warn: true }
      : bot.reinstallUrl
        ? { label: "Needs reinstall", dot: "bg-amber-600", warn: true }
        : bot.connected
          ? { label: "Connected", dot: "bg-green-600", ok: true }
          : { label: "Not connected", dot: "bg-muted-foreground" };
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm",
        status.ok
          ? "text-green-700 dark:text-green-400"
          : status.warn
            ? "text-amber-800 dark:text-amber-300"
            : "text-muted-foreground",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", status.dot)} />
      <span>{status.label}</span>
    </div>
  );
}

/**
 * The bot's token lacks scopes Archestra needs — typically right after
 * Archestra updated the app's settings, since Slack grants new scopes only on
 * a reinstall. Says how, and re-checks on request.
 */
function ReinstallRow({
  reinstallUrl,
  missingScopes,
  checking,
  onCheckAgain,
}: {
  reinstallUrl: string;
  missingScopes: string[];
  checking: boolean;
  onCheckAgain: () => void;
}) {
  return (
    <div className="mx-5 mb-4 flex @3xl:ml-[68px] flex-wrap items-center gap-4 rounded-lg bg-amber-50 px-3.5 py-3 dark:bg-amber-950/40">
      <p className="flex-1 text-sm leading-relaxed text-amber-950 dark:text-amber-100">
        Slack needs a reinstall to grant{" "}
        {missingScopes.map((scope, index) => (
          <span key={scope}>
            {index > 0 && <span>, </span>}
            <code className="font-mono text-xs">{scope}</code>
          </span>
        ))}
        . Click <strong>Reinstall to Workspace</strong> on the app's page and
        approve.
      </p>
      <Button size="sm" variant="outline" asChild>
        <a href={reinstallUrl} target="_blank" rel="noopener noreferrer">
          <span>Open in Slack</span>
          <ArrowUpRight />
        </a>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={checking}
        onClick={onCheckAgain}
      >
        {checking ? <span>Checking...</span> : <span>Check again</span>}
      </Button>
    </div>
  );
}

/**
 * The Slack app connected the old way answers whichever agent each channel
 * picks. Converting makes it one agent's bot, as if Archestra had created it
 * for that agent; the agent its channels use most is suggested.
 */
function ConvertAppCard({
  app,
  agents,
}: {
  app: UnassignedApp;
  agents: AgentRef[];
}) {
  const mutation = useConvertSlackAppToAgentBot();
  const suggested = app.agentUsage.find((usage) =>
    agents.some((agent) => agent.id === usage.agentId),
  );
  const [agentId, setAgentId] = useState(suggested?.agentId ?? "");
  const picked = agents.find((agent) => agent.id === agentId);
  const otherAgents = app.agentUsage.filter(
    (usage) => usage.agentId !== agentId,
  );

  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold">
          Turn your Slack app into an agent's bot
        </p>
        <p className="text-sm text-muted-foreground">
          App {app.appId} keeps its name, token, channels, and DMs, and answers
          as one agent from now on.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchableSelect
          value={agentId}
          onValueChange={setAgentId}
          placeholder="Choose an agent…"
          ariaLabel="Agent for the existing Slack app"
          searchPlaceholder="Search agents..."
          items={agents.map((agent) => {
            const usage = app.agentUsage.find((u) => u.agentId === agent.id);
            return {
              value: agent.id,
              label: agent.name,
              ...(usage && {
                description: `Used in ${usage.bindings} ${usage.bindings === 1 ? "channel" : "channels"}`,
              }),
            };
          })}
          className="w-72"
        />
        <Button
          size="sm"
          disabled={!picked || mutation.isPending}
          onClick={() => picked && mutation.mutate(picked.id)}
        >
          {mutation.isPending ? (
            <span>Converting...</span>
          ) : (
            <span>Convert</span>
          )}
        </Button>
      </div>
      {otherAgents.length > 0 && (
        <p className="text-xs text-muted-foreground">
          These agents stop answering through it — give them their own bots:{" "}
          {otherAgents
            .map(
              (usage) =>
                `${usage.agentName} (${usage.bindings} ${usage.bindings === 1 ? "channel" : "channels"})`,
            )
            .join(", ")}
          .
        </p>
      )}
    </div>
  );
}

/** Rare settings, out of the way until someone needs them. */
function AdvancedSettings({
  canCreateApps,
  onReplaceToken,
  connectionModeSettings,
}: {
  canCreateApps: boolean;
  onReplaceToken: () => void;
  connectionModeSettings: React.ReactNode;
}) {
  const migrateMutation = useMigrateSlackApps();
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
        >
          <ChevronRight
            className={cn("transition-transform", open && "rotate-90")}
          />
          <span>Advanced</span>
        </Button>
      </CollapsibleTrigger>
      {!open && (
        <p className="pl-6 text-xs text-muted-foreground">
          Connection mode, Slack configuration token, update Slack apps
        </p>
      )}
      <CollapsibleContent className="mt-3 flex flex-col gap-6 rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold">Connection mode</p>
          {connectionModeSettings}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold">Slack configuration token</p>
            <p className="text-sm text-muted-foreground">
              {canCreateApps ? (
                <span>Saved, and renewed automatically.</span>
              ) : (
                <span>Not saved — Slack apps are set up by hand.</span>
              )}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onReplaceToken}>
            {canCreateApps ? <span>Replace</span> : <span>Add token</span>}
          </Button>
        </div>
        {canCreateApps && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-semibold">Update Slack apps</p>
              <p className="text-sm text-muted-foreground">
                Re-apply the agent experience, events, and scopes to every
                connected app.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={migrateMutation.isPending}
              onClick={() => migrateMutation.mutate()}
            >
              {migrateMutation.isPending ? (
                <span>Updating...</span>
              ) : (
                <span>Update now</span>
              )}
            </Button>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Asks once for the token pair that lets Archestra create Slack apps. Slack
 * shows it under "Your App Configuration Tokens" on api.slack.com/apps.
 */
function ConnectSlackDialog({
  replacing,
  onClose,
  onConnected,
}: {
  /** A token is already saved; this replaces it. */
  replacing: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const appName = useAppName();
  const mutation = useSaveSlackAppConfigToken();
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const canSave = Boolean(accessToken && refreshToken);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={replacing ? "Replace configuration token" : "Connect Slack"}
      description={`${appName} creates a Slack app for each agent with this token. You do this once; the token renews itself.`}
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSave) return;
          const saved = await mutation.mutateAsync({
            accessToken,
            refreshToken,
          });
          if (saved?.success) onConnected();
        }}
      >
        <DialogBody className="flex flex-col gap-5">
          <ol className="flex flex-col gap-4">
            <Step number={1}>
              Open{" "}
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline hover:no-underline"
              >
                api.slack.com/apps
                <ExternalLink className="size-3" />
              </a>{" "}
              and scroll to <strong>Your App Configuration Tokens</strong>.
            </Step>
            <Step number={2}>
              Click <strong>Generate Token</strong> and pick your workspace.
            </Step>
            <Step number={3}>
              <div className="flex flex-col gap-3">
                <span>Copy both tokens here.</span>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="slack-config-access-token">
                    Access token
                  </Label>
                  <SecretInput
                    id="slack-config-access-token"
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    placeholder="xoxe.xoxp-1-…"
                    className="font-mono"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="slack-config-refresh-token">
                    Refresh token
                  </Label>
                  <SecretInput
                    id="slack-config-refresh-token"
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    placeholder="xoxe-1-…"
                    className="font-mono"
                  />
                </div>
              </div>
            </Step>
          </ol>
          <p className="rounded-lg bg-muted px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
            Your existing Slack apps are switched to the agent experience too:
            Stop button, streamed replies, and suggested prompts.
          </p>
        </DialogBody>
        <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? (
              <span>Connecting...</span>
            ) : (
              <span>Connect</span>
            )}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function Step({
  number,
  children,
}: {
  number: number;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
        {number}
      </span>
      <div className="flex-1 pt-px text-sm leading-relaxed">{children}</div>
    </li>
  );
}

/**
 * Pick an agent and Archestra creates its Slack app. Slack asks to approve the
 * install; with an HTTPS address it then sends the browser back here, otherwise
 * the admin pastes the tokens Slack shows.
 */
function AddBotDialog({
  agents,
  connectionMode,
  onClose,
  onManual,
  onNeedsTokens,
}: {
  agents: AgentRef[];
  connectionMode: ConnectionMode;
  onClose: () => void;
  onManual: (agent: AgentRef) => void;
  onNeedsTokens: (target: FinishTarget) => void;
}) {
  const appName = useAppName();
  const mutation = useCreateSlackAgentBotApp();
  const [agentId, setAgentId] = useState("");
  // Null until edited: the handle then follows the picked agent's name.
  const [customHandle, setCustomHandle] = useState<string | null>(null);
  const picked = agents.find((agent) => agent.id === agentId);
  const handle =
    customHandle ?? (picked ? slackHandleFor(appName, picked.name) : "");
  const handleValid = SLACK_BOT_HANDLE_PATTERN.test(handle);
  const iconIsImage = Boolean(picked?.icon?.startsWith("data:image/"));

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add Slack bot"
      description="Pick the agent. People will @mention it by this name."
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!picked || !handleValid) return;
          const created = await mutation.mutateAsync({
            agentId: picked.id,
            body: { appName: handle, connectionMode },
          });
          if (!created) return;
          if (created.installMode === "oauth") {
            // Slack asks to approve the install, then sends the browser back.
            window.location.assign(created.installUrl);
            return;
          }
          window.open(created.installUrl, "_blank", "noopener,noreferrer");
          onNeedsTokens({
            id: picked.id,
            name: picked.name,
            appId: created.appId,
            needsBotToken: true,
            needsAppLevelToken: connectionMode === "socket",
          });
        }}
      >
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-slack-bot-agent">Agent</Label>
            <SearchableSelect
              id="new-slack-bot-agent"
              value={agentId}
              onValueChange={(value) => {
                setAgentId(value);
                setCustomHandle(null);
              }}
              placeholder="Choose an agent…"
              searchPlaceholder="Search agents..."
              items={agents.map((agent) => ({
                value: agent.id,
                label: agent.name,
              }))}
            />
          </div>
          {picked && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-slack-bot-handle">Slack name</Label>
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  <AgentIcon icon={picked.icon} size={24} />
                </div>
                <div className="relative flex-1">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm text-muted-foreground">
                    @
                  </span>
                  <Input
                    id="new-slack-bot-handle"
                    value={handle}
                    onChange={(e) =>
                      setCustomHandle(
                        e.target.value.toLowerCase().replace(/\s+/g, "_"),
                      )
                    }
                    aria-invalid={!handleValid}
                    className="pl-7 font-mono"
                  />
                </div>
              </div>
              <p
                className={cn(
                  "text-xs",
                  handleValid ? "text-muted-foreground" : "text-destructive",
                )}
              >
                {handleValid ? (
                  <span>
                    People type this after @.{" "}
                    {customHandle === null
                      ? "It follows the agent's name when you rename the agent."
                      : "It stays as you set it when the agent is renamed."}
                  </span>
                ) : (
                  <span>
                    Use lowercase letters, digits, periods, hyphens, and
                    underscores — at most 35.
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {iconIsImage ? (
                  <span>
                    The bot uses the agent's icon, and keeps it in sync.
                  </span>
                ) : (
                  <span>
                    Slack app icons must be images; give the agent an image icon
                    to use it in Slack.
                  </span>
                )}
              </p>
            </div>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            disabled={!picked}
            onClick={() => picked && onManual(picked)}
          >
            Set up by hand
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!picked || !handleValid || mutation.isPending}
          >
            {mutation.isPending ? (
              <span>Creating...</span>
            ) : (
              <span>Create bot</span>
            )}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

/**
 * Collects the tokens Slack cannot hand over on its own: the bot token when the
 * app was installed from its Slack page, and the app-level token Socket Mode
 * needs.
 */
function FinishSetupDialog({
  target,
  onClose,
}: {
  target: FinishTarget;
  onClose: () => void;
}) {
  const mutation = useUpdateSlackAgentBot(target.id);
  const [botToken, setBotToken] = useState("");
  const [appLevelToken, setAppLevelToken] = useState("");
  const canSave =
    (!target.needsBotToken || botToken) &&
    (!target.needsAppLevelToken || appLevelToken);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Finish ${target.name}'s Slack bot`}
      description="Slack does not hand these tokens to Archestra on its own."
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSave) return;
          const saved = await mutation.mutateAsync({
            ...(botToken && { botToken }),
            ...(appLevelToken && { appLevelToken }),
          });
          if (saved?.success) onClose();
        }}
      >
        <DialogBody className="flex flex-col gap-5">
          <ol className="flex flex-col gap-4">
            {target.needsBotToken && (
              <Step number={1}>
                <div className="flex flex-col gap-3">
                  <span>
                    On the app's{" "}
                    <SlackAppLink appId={target.appId} path="oauth">
                      OAuth &amp; Permissions page
                    </SlackAppLink>
                    , click <strong>Install to Workspace</strong>, then copy the{" "}
                    <strong>Bot User OAuth Token</strong>.
                  </span>
                  <SecretInput
                    aria-label="Bot User OAuth Token"
                    masked={false}
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="xoxb-…"
                    className="font-mono"
                  />
                </div>
              </Step>
            )}
            {target.needsAppLevelToken && (
              <Step number={target.needsBotToken ? 2 : 1}>
                <div className="flex flex-col gap-3">
                  <span>
                    Under{" "}
                    <SlackAppLink appId={target.appId} path="general">
                      App-Level Tokens
                    </SlackAppLink>
                    , generate one with the <code>connections:write</code>{" "}
                    scope.
                  </span>
                  <SecretInput
                    aria-label="App-Level Token"
                    masked={false}
                    value={appLevelToken}
                    onChange={(e) => setAppLevelToken(e.target.value)}
                    placeholder="xapp-…"
                    className="font-mono"
                  />
                </div>
              </Step>
            )}
          </ol>
        </DialogBody>
        <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? (
              <span>Connecting...</span>
            ) : (
              <span>Connect</span>
            )}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function SlackAppLink({
  appId,
  path,
  children,
}: {
  appId: string;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={`https://api.slack.com/apps/${appId}/${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary underline hover:no-underline"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/** Report the result of a one-click install Slack redirected back from. */
function useInstallResultToast() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const installed = searchParams.get("slackBotInstalled");
  const error = searchParams.get("slackBotError");

  useEffect(() => {
    if (!installed && !error) return;
    if (installed) toast.success("Slack bot installed");
    if (error) toast.error(`Slack bot install failed: ${error}`);
    router.replace("/settings/messaging-channels/slack");
  }, [installed, error, router]);
}
