"use client";

import {
  type archestraApiTypes,
  buildSlackSlashCommands,
  SLACK_BOT_HANDLE_PATTERN,
  slackHandleFor,
} from "@archestra/shared";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/agent-icon";
import { AgentSelector } from "@/components/agent-selector";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { SlackBotEditDialog } from "@/components/slack-bot-edit-dialog";
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
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { useSession } from "@/lib/auth/auth.query";
import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import {
  useConvertSlackAppToAgentBot,
  useCreateSlackAgentBotApp,
  useCreateSlackRouterBotApp,
  useDeleteSlackAgentBot,
  useMigrateSlackApps,
  useSaveSlackAppConfigToken,
  useSlackAgentBotChannels,
  useSlackAgentBots,
  useUpdateSlackAgentBot,
  useUpdateSlackChatOpsConfig,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

type ConnectionMode = "socket" | "webhook";

/**
 * Slack, set up as one bot per agent. Each bot is its own Slack app that
 * always answers as its agent, so people @mention the agent by name — several
 * can share a channel and a thread. With their own Slack app configuration
 * token saved, Archestra creates each app for the person adding the bot. Slack
 * makes that person the app's only collaborator, so they then add their team.
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
  const { data: agents = [] } = useAgentOptionsByIds({
    ids: bots.map((bot) => bot.agentId),
  });
  const deleteMutation = useDeleteSlackAgentBot();
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const [connectOpen, setConnectOpen] = useState(false);
  // What to open once the token is saved: opened from "Add Slack bot" or from
  // converting the router bot, both of which need it.
  const [afterConnect, setAfterConnect] = useState<
    "add" | "router" | "convert" | null
  >(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addRouterOpen, setAddRouterOpen] = useState(false);
  const [routerSetupOpen, setRouterSetupOpen] = useState(false);
  const [routerEditOpen, setRouterEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [manualAgent, setManualAgent] = useState<AgentRef | null>(null);
  const [finishBot, setFinishBot] = useState<FinishTarget | null>(null);
  const [removeBot, setRemoveBot] = useState<
    (AgentRef & { handle: string }) | null
  >(null);
  const [editBot, setEditBot] = useState<AgentBot | null>(null);
  const [shareBot, setShareBot] = useState<ShareTarget | null>(null);

  // Right after a one-click install, the creator gives their team access.
  useInstallResult((agentId) => {
    if (agentId === ROUTER_INSTALL_ID) {
      if (!routerBot) return;
      if (routerBot.needsAppLevelToken) {
        openRouterFinish(routerBot);
      } else if (routerBot.createdBy?.id === userId) {
        setShareBot({
          appId: routerBot.appId,
          handle: routerBot.handle ?? appName.toLowerCase(),
        });
      }
      return;
    }
    const bot = bots.find((candidate) => candidate.agentId === agentId);
    if (bot?.needsAppLevelToken) {
      openFinish(bot);
    } else if (bot && bot.createdBy?.id === userId) {
      setShareBot({
        appId: bot.appId,
        handle: bot.handle ?? slackHandleFor(appName, bot.agentName),
      });
    }
  }, isLoading || !userId);

  const startAdd = () => {
    if (canCreateApps) {
      setAddOpen(true);
    } else {
      setAfterConnect("add");
      setConnectOpen(true);
    }
  };

  const startAddRouter = () => {
    if (canCreateApps) {
      setAddRouterOpen(true);
    } else {
      setAfterConnect("router");
      setConnectOpen(true);
    }
  };

  // Converting goes through Slack's manifest API, so it needs the token too.
  const startConvert = () => {
    if (canCreateApps) {
      setConvertOpen(true);
    } else {
      setAfterConnect("convert");
      setConnectOpen(true);
    }
  };

  // Arriving from an agent's page (?addBot=<agentId>): add that agent's bot.
  const searchParams = useSearchParams();
  const router = useRouter();
  const addBotFor = searchParams.get("addBot");
  const [presetAgentId, setPresetAgentId] = useState<string | null>(null);
  useEffect(() => {
    if (!addBotFor || isLoading) return;
    setPresetAgentId(addBotFor);
    if (canCreateApps) {
      setAddOpen(true);
    } else {
      setAfterConnect("add");
      setConnectOpen(true);
    }
    router.replace("/settings/messaging-channels/slack");
  }, [addBotFor, isLoading, canCreateApps, router]);

  const excludedAgentIds = bots.map((bot) => bot.agentId);
  // The router bot answers as whichever agent each DM or channel picks.
  const routerBot = data?.unassignedApp ?? null;
  const isEmpty = !isLoading && bots.length === 0 && !routerBot;

  const openRouterFinish = (bot: UnassignedApp) =>
    setFinishBot({
      id: ROUTER_INSTALL_ID,
      name: "Router",
      router: true,
      appId: bot.appId,
      needsBotToken: !bot.installed,
      needsAppLevelToken: bot.needsAppLevelToken,
      addTeam: Boolean(userId) && bot.createdBy?.id === userId,
    });

  const openFinish = (bot: AgentBot) =>
    setFinishBot({
      id: bot.agentId,
      name: bot.agentName,
      appId: bot.appId,
      needsBotToken: !bot.installed,
      needsAppLevelToken: bot.needsAppLevelToken,
      addTeam: Boolean(userId) && bot.createdBy?.id === userId,
    });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {bots.length > 0 || routerBot ? (
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
              {bots.length} agent {bots.length === 1 ? "bot" : "bots"}
              {routerBot && <span> · router bot</span>}
            </span>
          ) : (
            <span>Not connected yet</span>
          )}
          {!isLoading && (
            <span className="inline-flex items-center gap-1.5">
              Your Slack token
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  canCreateApps
                    ? "bg-green-500/10 text-green-700 dark:text-green-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {canCreateApps ? "Saved" : "Not saved"}
              </span>
            </span>
          )}
        </p>
        {!isEmpty && (
          <Button size="sm" onClick={startAdd}>
            <Plus />
            <span>Add Slack bot</span>
          </Button>
        )}
      </div>

      {!isLoading && !isEmpty && (
        <RouterBotCard
          bot={routerBot}
          userId={userId}
          onAdd={startAddRouter}
          onEdit={() => setRouterEditOpen(true)}
          onFinish={() => routerBot && openRouterFinish(routerBot)}
          onShare={(target) => setShareBot(target)}
          onConvert={startConvert}
        />
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
            <Button onClick={startAdd}>
              {canCreateApps ? (
                <span>Add Slack bot</span>
              ) : (
                <span>Connect Slack</span>
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              Takes about a minute. You paste your token from Slack; {appName}{" "}
              creates the apps.
            </p>
            <p className="text-xs text-muted-foreground">
              Prefer one bot where people pick their agent?{" "}
              <UnstyledButton
                className="underline hover:no-underline"
                onClick={startAddRouter}
              >
                Add a router bot
              </UnstyledButton>
            </p>
          </div>
        </div>
      )}

      {bots.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            Agent bots
          </h3>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bot</TableHead>
                  <TableHead className="w-[20%]">Agent</TableHead>
                  <TableHead className="w-[24%]">Channels</TableHead>
                  <TableHead className="w-[17%]">Managed in Slack by</TableHead>
                  <TableHead className="w-[64px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {bots.map((bot) => {
                  const handle =
                    bot.handle ?? slackHandleFor(appName, bot.agentName);
                  const health = botHealth(bot);
                  const needsSetup = !bot.installed || bot.needsAppLevelToken;
                  const notes =
                    bot.identitySyncError ||
                    (bot.installed && bot.reinstallUrl);
                  const agent = agents.find(
                    (candidate) => candidate.id === bot.agentId,
                  );
                  return (
                    <Fragment key={bot.agentId}>
                      <TableRow className={cn(notes && "border-b-0")}>
                        <TableCell>
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              title={health.label}
                              className={cn(
                                "size-2 shrink-0 rounded-full",
                                health.dot,
                              )}
                            />
                            <div className="flex min-w-0 flex-col items-start">
                              <UnstyledButton
                                className="max-w-full truncate text-left font-medium hover:underline"
                                onClick={() =>
                                  needsSetup ? openFinish(bot) : setEditBot(bot)
                                }
                              >
                                @{handle}
                              </UnstyledButton>
                              {health.problem ? (
                                <span className="text-xs text-amber-800 dark:text-amber-300">
                                  {health.label}
                                  {needsSetup && (
                                    <span>
                                      {" · "}
                                      <UnstyledButton
                                        className="underline hover:no-underline"
                                        onClick={() => openFinish(bot)}
                                      >
                                        Finish setup
                                      </UnstyledButton>
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <span className="sr-only">{health.label}</span>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Link
                            href={`/agents/${bot.agentId}`}
                            className="flex min-w-0 items-center gap-2 hover:underline"
                          >
                            <AgentIcon icon={agent?.icon} size={16} />
                            <span className="truncate">{bot.agentName}</span>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <BotChannels
                            agentId={bot.agentId}
                            installed={bot.installed}
                          />
                        </TableCell>
                        <TableCell className="truncate">
                          {!bot.createdBy ? (
                            <span className="text-muted-foreground">—</span>
                          ) : bot.createdBy.id === userId ? (
                            "You"
                          ) : (
                            (bot.createdBy.name ?? "A teammate")
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon-sm"
                                  variant="outline"
                                  aria-label={`More actions for @${handle}`}
                                >
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() =>
                                    needsSetup
                                      ? openFinish(bot)
                                      : setEditBot(bot)
                                  }
                                >
                                  {needsSetup ? "Finish setup" : "Edit"}
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild>
                                  <a
                                    href={`https://api.slack.com/apps/${bot.appId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Open in Slack ({bot.appId})
                                  </a>
                                </DropdownMenuItem>
                                {bot.createdBy?.id === userId && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      setShareBot({ appId: bot.appId, handle })
                                    }
                                  >
                                    Give your team access
                                  </DropdownMenuItem>
                                )}
                                {bot.createdBy &&
                                  bot.createdBy.id !== userId && (
                                    <DropdownMenuItem disabled>
                                      Ask {bot.createdBy.name ?? "its creator"}{" "}
                                      to add you in Slack
                                    </DropdownMenuItem>
                                  )}
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() =>
                                    setRemoveBot({
                                      id: bot.agentId,
                                      name: `@${handle}`,
                                      handle,
                                    })
                                  }
                                >
                                  Remove bot
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                      {notes && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={5} className="pt-0 pb-3">
                            <div className="flex flex-col gap-2">
                              {bot.identitySyncError && (
                                <p className="text-xs text-amber-800 dark:text-amber-300">
                                  Slack did not take the agent's latest name or
                                  icon: {bot.identitySyncError}
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
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
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
          onClose={() => {
            setConnectOpen(false);
            setAfterConnect(null);
          }}
          onConnected={() => {
            setConnectOpen(false);
            if (afterConnect === "add") setAddOpen(true);
            if (afterConnect === "router") setAddRouterOpen(true);
            if (afterConnect === "convert") setConvertOpen(true);
            setAfterConnect(null);
          }}
        />
      )}

      {shareBot && (
        <ShareWithTeamDialog
          target={shareBot}
          onClose={() => setShareBot(null)}
        />
      )}

      {addOpen && (
        <AddBotDialog
          excludedAgentIds={excludedAgentIds}
          initialAgentId={presetAgentId ?? ""}
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

      {addRouterOpen && (
        <AddRouterBotDialog
          connectionMode={connectionMode}
          onClose={() => setAddRouterOpen(false)}
          onManual={() => {
            setAddRouterOpen(false);
            setRouterSetupOpen(true);
          }}
          onNeedsTokens={(target) => {
            setAddRouterOpen(false);
            setFinishBot(target);
          }}
        />
      )}

      {routerSetupOpen && (
        <SlackSetupDialog
          open
          onOpenChange={(open) => {
            if (!open) setRouterSetupOpen(false);
          }}
          connectionMode={connectionMode}
        />
      )}

      {convertOpen && routerBot && (
        <ConvertRouterBotDialog
          bot={routerBot}
          excludedAgentIds={excludedAgentIds}
          onClose={() => setConvertOpen(false)}
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

      {routerEditOpen && routerBot && (
        <SlackBotEditDialog
          open
          onOpenChange={(open) => {
            if (!open) setRouterEditOpen(false);
          }}
          agentId={null}
          handle={routerBot.handle ?? appName.toLowerCase()}
          appId={routerBot.appId}
          installed={routerBot.installed}
          reinstallUrl={null}
        />
      )}

      {editBot && (
        <SlackBotEditDialog
          key={editBot.agentId}
          open
          onOpenChange={(open) => {
            if (!open) setEditBot(null);
          }}
          agentId={editBot.agentId}
          handle={editBot.handle ?? slackHandleFor(appName, editBot.agentName)}
          appId={editBot.appId}
          installed={editBot.installed}
          reinstallUrl={editBot.reinstallUrl}
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
        confirmationPhrase={removeBot?.handle}
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
  /** The router bot rather than an agent's bot. */
  router?: boolean;
  appId: string;
  needsBotToken: boolean;
  needsAppLevelToken: boolean;
  /** The viewer created the app, so only they can add the team in Slack. */
  addTeam: boolean;
};

type ShareTarget = { appId: string; handle: string };

/** What a finished install of the router bot reports instead of an agent id. */
const ROUTER_INSTALL_ID = "router";

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

/**
 * Whether the bot works, as a dot beside its handle. Only a problem gets
 * words on the row; a working bot needs none.
 */
function botHealth(bot: AgentBot): {
  label: string;
  dot: string;
  problem: boolean;
} {
  if (!bot.installed) {
    return {
      label: "Not installed",
      dot: "border-[1.5px] border-muted-foreground",
      problem: true,
    };
  }
  if (bot.needsAppLevelToken) {
    return {
      label: "Needs app-level token",
      dot: "bg-amber-600",
      problem: true,
    };
  }
  if (bot.reinstallUrl) {
    return { label: "Needs reinstall", dot: "bg-amber-600", problem: true };
  }
  return bot.connected
    ? { label: "Connected", dot: "bg-green-600", problem: false }
    : { label: "Not connected", dot: "bg-muted-foreground", problem: true };
}

/** How many channels the bot is in, and where it replies to every message. */
function BotChannels({
  agentId,
  installed,
}: {
  agentId: string;
  installed: boolean;
}) {
  const channels = useSlackAgentBotChannels(installed ? agentId : undefined);
  const bindings = useAllChatOpsBindings();
  const memberCount = channels.data?.channels.filter(
    (channel) => channel.isMember,
  ).length;
  const repliesToAll = (bindings.data?.bindings ?? []).filter(
    (binding) =>
      binding.provider === "slack" &&
      !binding.isDm &&
      binding.answerAllMessages &&
      binding.agentId === agentId,
  );
  if (!installed) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="flex min-w-0 flex-col">
      <span>
        {memberCount === undefined
          ? "…"
          : memberCount === 1
            ? "1 channel"
            : `${memberCount} channels`}
      </span>
      {repliesToAll.length > 0 && (
        <span className="truncate text-xs text-muted-foreground">
          Replies to all in{" "}
          {repliesToAll
            .map((binding) => `#${binding.channelName ?? binding.channelId}`)
            .join(", ")}
        </span>
      )}
    </span>
  );
}

/**
 * The bot's token lacks scopes/**
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
    <div className="flex flex-wrap items-center gap-4 rounded-lg bg-amber-50 px-3.5 py-3 dark:bg-amber-950/40">
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
 * The router bot: one Slack app that answers as whichever agent each DM or
 * channel picks with /select-agent, and sends one message to another agent with
 * "Agent > message". It lives next to the agents' own bots, for personal agents
 * and ones people rarely use. Turning it into one agent's bot is opt-in.
 */
function RouterBotCard({
  bot,
  userId,
  onAdd,
  onEdit,
  onFinish,
  onShare,
  onConvert,
}: {
  bot: UnassignedApp | null;
  userId: string | undefined;
  onAdd: () => void;
  onEdit: () => void;
  onFinish: () => void;
  onShare: (target: ShareTarget) => void;
  onConvert: () => void;
}) {
  const appName = useAppName();

  if (!bot) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed bg-card p-5">
        <div className="flex max-w-[640px] flex-col gap-1">
          <p className="text-sm font-semibold">No router bot</p>
          <p className="text-sm text-muted-foreground">
            A router bot lets each person pick their own agent in a DM, and
            anyone send one message to another agent with{" "}
            <code className="font-mono text-xs">Agent &gt; message</code>.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onAdd}>
          <Plus />
          <span>Add router bot</span>
        </Button>
      </div>
    );
  }

  const handle = bot.handle ?? appName.toLowerCase();
  // Slack commands are named after the app: "@archestra_all" has
  // "/archestra-all-select-agent".
  const selectAgentCommand = buildSlackSlashCommands(
    bot.handle ?? appName,
  ).SELECT_AGENT;
  const needsSetup = !bot.installed || bot.needsAppLevelToken;
  const problem = !bot.installed
    ? "Not installed"
    : bot.needsAppLevelToken
      ? "Needs app-level token"
      : bot.connected
        ? null
        : "Not connected";
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-5">
      <div className="flex max-w-[680px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            title={bot.connected ? "Connected" : "Not connected"}
            className={cn(
              "size-2 shrink-0 rounded-full",
              bot.connected ? "bg-green-600" : "bg-muted-foreground",
            )}
          />
          <span className="font-medium">@{handle}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Router
          </span>
          {problem && (
            <span className="text-xs text-amber-800 dark:text-amber-300">
              {problem}
              {needsSetup && (
                <span>
                  {" · "}
                  <UnstyledButton
                    className="underline hover:no-underline"
                    onClick={onFinish}
                  >
                    Finish setup
                  </UnstyledButton>
                </span>
              )}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Answers as the agent each person picks in their DM, or the channel's
          default agent. Change it with{" "}
          <code className="font-mono text-xs">{selectAgentCommand}</code>.
          Anyone can send one message to another agent with{" "}
          <code className="font-mono text-xs">
            @{handle} Agent &gt; message
          </code>
          , and see the agents with{" "}
          <code className="font-mono text-xs">@{handle} list</code>.
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`More actions for @${handle}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {needsSetup ? (
            <DropdownMenuItem onSelect={onFinish}>
              Finish setup
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
          )}
          {bot.appId && (
            <DropdownMenuItem asChild>
              <a
                href={`https://api.slack.com/apps/${bot.appId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Slack ({bot.appId})
              </a>
            </DropdownMenuItem>
          )}
          {bot.createdBy?.id === userId && (
            <DropdownMenuItem
              onSelect={() => onShare({ appId: bot.appId, handle })}
            >
              Give your team access
            </DropdownMenuItem>
          )}
          {bot.createdBy && bot.createdBy.id !== userId && (
            <DropdownMenuItem disabled>
              Ask {bot.createdBy.name ?? "its creator"} to add you in Slack
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onConvert}>
            Convert to an agent's bot…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Make the router bot one agent's bot, as if Archestra had created it for that
 * agent. Its token and DMs carry over; picking agents goes away. The agent its
 * channels use most is suggested.
 */
function ConvertRouterBotDialog({
  bot,
  excludedAgentIds,
  onClose,
}: {
  bot: UnassignedApp;
  excludedAgentIds: string[];
  onClose: () => void;
}) {
  const appName = useAppName();
  const mutation = useConvertSlackAppToAgentBot();
  const { data: candidates = [] } = useAgentOptionsByIds({
    ids: bot.agentUsage
      .map((usage) => usage.agentId)
      .filter((id) => !excludedAgentIds.includes(id)),
  });
  const suggested = bot.agentUsage.find((usage) =>
    candidates.some((agent) => agent.id === usage.agentId),
  );
  const [selectedId, setAgentId] = useState<string | null>(null);
  const agentId = selectedId ?? suggested?.agentId ?? "";
  const { data: selectedAgents = [] } = useAgentOptionsByIds({
    ids: agentId ? [agentId] : [],
  });
  const picked = selectedAgents.find(
    (agent) => agent.id === agentId && !excludedAgentIds.includes(agent.id),
  );
  const handle = bot.handle ?? appName.toLowerCase();

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Convert to an agent's bot"
      description={`@${handle} keeps its name, token, channels, and DMs, and answers as one agent from now on.`}
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!picked) return;
          const converted = await mutation.mutateAsync(picked.id);
          if (converted?.success) onClose();
        }}
      >
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Agent</Label>
            <AgentSelector
              mode="single"
              flat
              remote={{
                filters: {
                  agentType: "agent",
                  excludeBuiltIn: true,
                  excludeIds: excludedAgentIds,
                },
              }}
              value={agentId}
              onValueChange={setAgentId}
              placeholder="Choose an agent…"
              className="w-full"
            />
          </div>
          <InlineNotice>
            <AlertTriangle />
            <InlineNoticeText>
              People can no longer pick their own agent with{" "}
              <code className="font-mono text-xs">/select-agent</code> or use{" "}
              <code className="font-mono text-xs">Agent &gt; message</code>. Add
              a new router bot afterwards to keep them.
            </InlineNoticeText>
          </InlineNotice>
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!picked || mutation.isPending}>
            {mutation.isPending ? (
              <span>Converting...</span>
            ) : (
              <span>Convert</span>
            )}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

/**
 * Create the router bot's Slack app with the person's configuration token. With
 * an HTTPS public URL it installs in one click; otherwise the person installs
 * it on Slack and pastes its tokens.
 */
function AddRouterBotDialog({
  connectionMode,
  onClose,
  onManual,
  onNeedsTokens,
}: {
  connectionMode: ConnectionMode;
  onClose: () => void;
  onManual: () => void;
  onNeedsTokens: (target: FinishTarget) => void;
}) {
  const appName = useAppName();
  const mutation = useCreateSlackRouterBotApp();
  const [handle, setHandle] = useState(slackHandleFor(appName, "all"));
  const handleValid = SLACK_BOT_HANDLE_PATTERN.test(handle);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add router bot"
      description="People pick their own agent in a DM with it, and send one message to another agent with Agent > message."
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!handleValid) return;
          const created = await mutation.mutateAsync({
            appName: handle,
            connectionMode,
          });
          if (!created) return;
          if (created.installMode === "oauth") {
            // Slack asks to approve the install, then sends the browser back.
            window.location.assign(created.installUrl);
            return;
          }
          window.open(created.installUrl, "_blank", "noopener,noreferrer");
          onNeedsTokens({
            id: ROUTER_INSTALL_ID,
            name: "Router",
            router: true,
            appId: created.appId,
            needsBotToken: true,
            needsAppLevelToken: connectionMode === "socket",
            addTeam: true,
          });
        }}
      >
        <DialogBody className="flex flex-col gap-1.5">
          <Label htmlFor="new-slack-router-handle">Slack name</Label>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm text-muted-foreground">
              @
            </span>
            <Input
              id="new-slack-router-handle"
              value={handle}
              onChange={(e) =>
                setHandle(e.target.value.toLowerCase().replace(/\s+/g, "_"))
              }
              aria-invalid={!handleValid}
              className="pl-7 font-mono"
            />
          </div>
          <p
            className={cn(
              "text-xs",
              handleValid ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {handleValid ? (
              <span>People type this after @.</span>
            ) : (
              <span>
                Use lowercase letters, digits, periods, hyphens, and underscores
                — at most 35.
              </span>
            )}
          </p>
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            onClick={onManual}
          >
            Set up by hand
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!handleValid || mutation.isPending}>
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
            <p className="text-sm font-semibold">
              Your Slack configuration token
            </p>
            <p className="text-sm text-muted-foreground">
              {canCreateApps ? (
                <span>Saved, and renewed automatically.</span>
              ) : (
                <span>Yours is not saved. Add it to create Slack bots.</span>
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
                Re-apply the agent experience, events, and scopes to the
                connected apps you can manage in Slack.
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
 * Asks once per person for the token pair that lets Archestra create Slack
 * apps for them. Slack shows it under "Your App Configuration Tokens" on
 * api.slack.com/apps.
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
      title={replacing ? "Replace your configuration token" : "Connect Slack"}
      description={`${appName} creates Slack apps with your own token, so they are yours in Slack. You do this once; the token renews itself.`}
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
        <DialogStickyFooter className="mt-0">
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
  excludedAgentIds,
  connectionMode,
  onClose,
  onManual,
  onNeedsTokens,
  initialAgentId,
}: {
  excludedAgentIds: string[];
  connectionMode: ConnectionMode;
  onClose: () => void;
  onManual: (agent: AgentRef) => void;
  onNeedsTokens: (target: FinishTarget) => void;
  /** Preselect this agent (opened from the agent's own page). */
  initialAgentId: string;
}) {
  const appName = useAppName();
  const mutation = useCreateSlackAgentBotApp();
  const [agentId, setAgentId] = useState(initialAgentId);
  // Null until edited: the handle then follows the picked agent's name.
  const [customHandle, setCustomHandle] = useState<string | null>(null);
  const { data: selectedAgents = [] } = useAgentOptionsByIds({
    ids: agentId ? [agentId] : [],
  });
  const picked = selectedAgents.find(
    (agent) => agent.id === agentId && !excludedAgentIds.includes(agent.id),
  );
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
            addTeam: true,
          });
        }}
      >
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Agent</Label>
            <AgentSelector
              mode="single"
              flat
              remote={{
                filters: {
                  agentType: "agent",
                  excludeBuiltIn: true,
                  excludeIds: excludedAgentIds,
                },
              }}
              value={agentId}
              onValueChange={(value) => {
                setAgentId(value);
                setCustomHandle(null);
              }}
              placeholder="Choose an agent…"
              className="w-full"
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
        <DialogStickyFooter className="mt-0">
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
  const appName = useAppName();
  const agentBotMutation = useUpdateSlackAgentBot(
    target.router ? undefined : target.id,
  );
  const routerMutation = useUpdateSlackChatOpsConfig();
  const mutation = target.router ? routerMutation : agentBotMutation;
  const [botToken, setBotToken] = useState("");
  const [appLevelToken, setAppLevelToken] = useState("");
  const canSave =
    (!target.needsBotToken || botToken) &&
    (!target.needsAppLevelToken || appLevelToken);
  const teamStep =
    Number(target.needsBotToken) + Number(target.needsAppLevelToken) + 1;

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        target.router
          ? "Finish the router bot"
          : `Finish ${target.name}'s Slack bot`
      }
      description={`Slack does not hand these tokens to ${appName} on its own.`}
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
            // The router app is saved switched off until it has its tokens.
            ...(target.router && { enabled: true }),
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
            {target.addTeam && (
              <Step number={teamStep}>
                <TeamAccessText appId={target.appId} />
              </Step>
            )}
          </ol>
        </DialogBody>
        <DialogStickyFooter className="mt-0">
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

/**
 * Slack makes whoever created an app its only collaborator, and has no API to
 * add others, so the creator adds their team on the app's Slack page.
 */
function TeamAccessText({ appId }: { appId: string }) {
  return (
    <span>
      Only you can open this app's settings in Slack. On its{" "}
      <SlackAppLink appId={appId} path="collaborators">
        Collaborators page
      </SlackAppLink>
      , add the teammates who should manage it too.
    </span>
  );
}

function ShareWithTeamDialog({
  target,
  onClose,
}: {
  target: ShareTarget;
  onClose: () => void;
}) {
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Give your team access to @${target.handle}`}
      description="Slack created the app under your account."
      size="small"
    >
      <DialogBody className="text-sm leading-relaxed">
        <TeamAccessText appId={target.appId} />
      </DialogBody>
      <DialogStickyFooter className="mt-0">
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

/**
 * Report the result of a one-click install Slack redirected back from, and
 * hand the installed bot's agent to `onInstalled` once the bots are loaded.
 */
function useInstallResult(
  onInstalled: (agentId: string) => void,
  loading: boolean,
) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const installed = searchParams.get("slackBotInstalled");
  const error = searchParams.get("slackBotError");
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;
  // Each result is reported once, even before the URL drops it.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (loading || (!installed && !error)) return;
    const result = `${installed}|${error}`;
    if (handled.current === result) return;
    handled.current = result;
    if (installed) {
      toast.success("Slack bot installed");
      onInstalledRef.current(installed);
    }
    if (error) toast.error(`Slack bot install failed: ${error}`);
    router.replace("/settings/messaging-channels/slack");
  }, [installed, error, router, loading]);
}
