"use client";

// The Connect page.
// The connect band below the hero carries the instruction as its heading,
// with one marker and one accent, so it reads as the next thing to do.
// A split hero, then a full-width connect band. Hero left: the headline and
// the agent picker (featured apps plus one "Other agents" tile that becomes
// the picked app, in place; with 1 to 3 tiles they sit in one row, centered
// in the picker area, unboxed). Hero right: a compact profile card for the
// chosen agent: its connection status (disconnect lives in "Manage" above
// the picker), light server and skill
// rows, then status chips (routing, guardrails). A future capability
// (budgets, audit...) is one more entry in `statusChips` in ProfileCard.
// Under the hero, spanning the page: the copy prompt, or the manual steps
// themselves when Manual is chosen.

import {
  hasNativeSetupSession,
  type NativeSessionClientId,
} from "@archestra/shared/connection-setup";
import {
  ArrowDown,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Gauge,
  Info,
  ListOrdered,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  TriangleAlert,
  Unplug,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { ClientIcon } from "@/app/connection/client-icon";
import type { ConnectClient } from "@/app/connection/clients";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { copyToClipboard } from "@/lib/clipboard";
import { useConnectionPromptSession } from "@/lib/connection-setup.query";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { cn } from "@/lib/utils/tailwind";
import {
  ALL_INCLUDED,
  type ConnectChoices,
  readConnectChoices,
  saveConnectChoices,
} from "./connect-choices";
import {
  type ConnectFootprint,
  type ConnectPageData,
  type ConnectPageSkill,
  type ConnectServer,
  useConnectPageData,
} from "./connect-page-data";
import {
  AgentSearch,
  CopyLine,
  DisconnectDialog,
  fmt,
  IncludeDialog,
  InfoDialog,
  labelOf,
  ManageDialog,
  nameOf,
  plural,
  suggestFirstPrompt,
  toolLoading,
  UndoDialog,
} from "./connect-page-parts";
import { type SetupMode, setupModeFor, useManualSteps } from "./manual-setup";
import { detectPlatform } from "./platform.utils";

type DialogKind =
  | "servers"
  | "skills"
  | "plugins"
  | "routing"
  | "guardrails"
  | "cursor";
type Status = "idle" | "waiting" | "connected";

/** The parts a user can leave out, in the words the page uses. */
const PART_LABELS: [keyof ConnectChoices, string][] = [
  ["tools", "tools"],
  ["skills", "skills"],
  ["proxy", "model routing"],
  ["plugins", "plugins"],
];

const MOTION_CSS = `
@keyframes v8-pop {
  0% { opacity: 0; transform: translateY(16px) scale(0.92); }
  55% { opacity: 1; transform: translateY(-5px) scale(1.025); }
  78% { transform: translateY(1.5px) scale(0.995); }
  100% { opacity: 1; transform: none; }
}
@keyframes v8-icon {
  0% { opacity: 0.3; transform: scale(0.78) rotate(-8deg); }
  60% { opacity: 1; transform: scale(1.07) rotate(2deg); }
  100% { opacity: 1; transform: none; }
}
.v8-chip { animation: v8-pop 0.62s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.v8-icon { animation: v8-icon 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
@media (prefers-reduced-motion: reduce) {
  .v8-chip, .v8-icon { animation: none; }
}
`;

export function ConnectPage() {
  usePageTitle("Connect");
  const data = useConnectPageData();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [manualChosen, setManualChosen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [focusServer, setFocusServer] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState<ConnectClient | null>(
    null,
  );
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  // Connecting an already connected agent again, e.g. on another machine:
  // the agent and its latest connect time when the user started.
  const [another, setAnother] = useState<{
    clientId: string;
    since: string;
  } | null>(null);
  // What the user leaves out, per agent. The prompt carries it, and this
  // browser keeps it for a while (connect-choices.ts).
  const [choices, setChoices] = useState<ConnectChoices>(ALL_INCLUDED);

  const connectedIds = useMemo(
    () => new Set<string>(data.connected.map((c) => c.clientId)),
    [data.connected],
  );
  const anotherConnectedAt = data.connected.find(
    (c) => c.clientId === another?.clientId,
  )?.lastConnectedAt;
  useEffect(() => {
    if (!waitingFor || !connectedIds.has(waitingFor)) return;
    // A repeat connect is done once the agent's latest connect time moves.
    if (
      another?.clientId === waitingFor &&
      String(anotherConnectedAt) === another.since
    )
      return;
    setWaitingFor(null);
    setAnother(null);
  }, [waitingFor, connectedIds, another, anotherConnectedAt]);
  // While a setup runs, check every few seconds so the page turns green on
  // its own once the agent connects.
  const { refetchConnected } = data;
  useEffect(() => {
    if (!waitingFor) return;
    const timer = window.setInterval(refetchConnected, 4000);
    return () => window.clearInterval(timer);
  }, [waitingFor, refetchConnected]);

  const skillsSorted = useMemo(
    () => [...data.skills].sort((a, b) => b.usageCount - a.usageCount),
    [data.skills],
  );

  const client =
    data.clients.find((c) => c.id === pickedId) ??
    data.featuredClients[0] ??
    data.clients[0];
  const clientId = client?.id;
  useEffect(() => {
    if (clientId) setChoices(readConnectChoices(clientId));
  }, [clientId]);

  if (data.loading || !client) return <LoadingState />;

  const parts = data.partsFor(client);
  const servers = choices.tools ? data.servers : [];
  const tools = servers.reduce((n, s) => n + s.toolCount, 0);
  const skillsOn = data.skillsEnabled && data.totalSkills > 0;
  const skills = skillsOn && choices.skills ? skillsSorted : [];
  const skillCount = skills.length;
  const prompt = data.connectPrompt(client, choices);
  const leftOut = PART_LABELS.filter(
    ([part]) => parts[part] && !choices[part],
  ).map(([, label]) => label);
  const setChoice = (part: keyof ConnectChoices, value: boolean) => {
    const next = { ...choices, [part]: value };
    setChoices(next);
    saveConnectChoices(client.id, next);
  };

  const setup = setupModeFor(client);
  const status: Status =
    connectedIds.has(client.id) && another?.clientId !== client.id
      ? "connected"
      : waitingFor === client.id
        ? "waiting"
        : "idle";
  const manual =
    status !== "connected" &&
    (setup === "manual" || (setup === "prompt-or-manual" && manualChosen));
  // Apps with an installer can also run it straight from a terminal. Claude
  // Desktop keeps its own download flow.
  const scriptable = setup === "prompt" && client.id !== "claude-desktop";
  const script = status !== "connected" && scriptable && manualChosen;
  const step = currentStep(client, status, manual, script);

  const pick = (id: string) => {
    setPickedId(id);
    setWaitingFor(null);
    setManualChosen(false);
    setAnother(null);
  };
  const connectedRecord = data.connected.find((c) => c.clientId === client.id);

  return (
    <div className="relative w-full overflow-hidden text-foreground">
      <style>{MOTION_CSS}</style>
      <DotField />

      <div className="relative mx-auto w-full max-w-7xl px-6 pt-10 pb-16 md:px-10 lg:px-14 lg:pt-12">
        {data.canManage && (
          <div className="absolute top-4 right-6 md:right-10 lg:right-14">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
            >
              <Link href="/settings/connection">
                <Settings />
                Connection settings
              </Link>
            </Button>
          </div>
        )}

        <section className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,29rem)] lg:gap-12 xl:grid-cols-[minmax(0,1fr)_minmax(0,31rem)] xl:gap-16">
          {/* Left: headline, picker */}
          <div className="min-w-0">
            <h1 className="text-4xl leading-[1.05] font-semibold tracking-tighter text-balance md:text-5xl xl:text-6xl">
              Connect your agent to {data.appName}
            </h1>
            <p className="mt-4 max-w-[34rem] text-lg leading-relaxed text-muted-foreground">
              The MCP servers and skills your organization runs for itself, now
              usable in your agent of choice.
            </p>

            <div className="mt-6 flex max-w-xl items-center justify-between gap-3">
              <h2 className="text-sm font-medium">
                {tileCount(data) === 1 ? "Your agent" : "Pick your agent"}
              </h2>
              {data.connected.length > 0 && (
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  <span className="tabular-nums">
                    {data.connected.length} connected
                  </span>
                  <span aria-hidden>·</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setManageOpen(true)}
                    className="h-7 gap-1.5 rounded-md px-2.5 text-xs text-foreground [&_svg]:size-3.5"
                  >
                    <SlidersHorizontal />
                    Manage
                  </Button>
                </span>
              )}
            </div>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Your organization's tools and skills get added to the agent you
              pick.
            </p>
            <AgentTiles
              data={data}
              selected={client}
              connectedIds={connectedIds}
              onPick={pick}
            />
          </div>

          {/* Right: the agent's profile card */}
          <ProfileCard
            data={data}
            client={client}
            status={status}
            servers={servers}
            tools={tools}
            skills={skills}
            skillCount={skillCount}
            onOpen={(d, server) => {
              setFocusServer(server ?? null);
              setDialog(d);
            }}
          />
        </section>

        {/* Full width under the hero: the prompt, or the manual steps. */}
        <ConnectArea
          data={data}
          client={client}
          setup={setup}
          status={status}
          step={step}
          manual={manual}
          scriptable={scriptable}
          script={script}
          choices={choices}
          prompt={prompt}
          firstPrompt={suggestFirstPrompt(servers, skills)}
          includeLabel={
            leftOut.length === 0
              ? "Choose what to include"
              : `Leaving out ${leftOut.join(", ")}`
          }
          onInclude={() => {
            setFocusServer(null);
            setDialog("servers");
          }}
          onManual={setManualChosen}
          onCopied={() => setWaitingFor(client.id)}
          onCursorNote={() => setDialog("cursor")}
          onDisconnect={() => setDisconnecting(client)}
          onConnectAnother={
            connectedRecord
              ? () =>
                  setAnother({
                    clientId: client.id,
                    since: String(connectedRecord.lastConnectedAt),
                  })
              : undefined
          }
          footprint={data.footprintFor(client)}
          skillCount={skillCount}
        />
      </div>

      <ManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        data={data}
        onDisconnect={setDisconnecting}
      />
      <DisconnectDialog
        data={data}
        client={disconnecting}
        onOpenChange={(v) => !v && setDisconnecting(null)}
      />

      <IncludeDialog
        open={
          dialog === "servers" || dialog === "skills" || dialog === "plugins"
        }
        tab={dialog === "skills" || dialog === "plugins" ? dialog : "servers"}
        focus={focusServer}
        onTab={(t) => setDialog(t)}
        onOpenChange={(v) => !v && setDialog(null)}
        data={data}
        client={client}
        skills={skillsSorted}
        choices={choices}
        onChoice={setChoice}
      />
      <InfoDialog
        open={dialog === "cursor"}
        onOpenChange={(v) => !v && setDialog(null)}
        title="Cursor keeps its own models"
      >
        <div className="space-y-2">
          <p>
            Connecting Cursor adds {data.appName}'s tools and skills. Cursor
            keeps using its current models.
          </p>
          <p>
            To send Cursor's OpenAI requests through {data.appName} too, keep
            model routing on in the browser approval. After setup, find "Cursor
            model settings (manual step)" in the installer output: it shows the
            proxy URL and, if chosen, a virtual key. In Cursor Settings, Models,
            API Keys, enter those values and turn on Use OpenAI API Key and
            Override OpenAI Base URL. A Cursor subscription can't be used as a
            key.
          </p>
        </div>
      </InfoDialog>
      <InfoDialog
        open={dialog === "routing"}
        onOpenChange={(v) => !v && setDialog(null)}
        title={`Model requests go through ${data.appName}`}
      >
        <p>
          {labelOf(client)} sends model requests through {data.appName} instead
          of straight to the provider. You keep the same models; your org's
          limits, logging and cost tracking apply.
        </p>
      </InfoDialog>
      <InfoDialog
        open={dialog === "guardrails"}
        onOpenChange={(v) => !v && setDialog(null)}
        title={`${data.guardrails.name} guardrails`}
      >
        <p>
          Before a risky tool call runs (deleting data, sending messages outside
          the org), {data.guardrails.name} checks it against your org's rules
          and can ask you to approve it first.
        </p>
      </InfoDialog>
    </div>
  );
}

// === Background ===

function DotField() {
  const mask =
    "linear-gradient(to bottom, black 0%, black 45%, transparent 100%)";
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[760px] opacity-70"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--border) 1.1px, transparent 1.4px)",
        backgroundSize: "26px 26px",
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    />
  );
}

// === Agent picker: the one place to pick ===

// Up to this many tiles sit in one centered row instead of the grid.
const ROW_MAX = 3;

/** Non-featured agents the admin allows (Generic client alone doesn't count). */
function hasOtherAgents(data: ConnectPageData) {
  const featuredIds = new Set(data.featuredClients.map((c) => c.id));
  return data.clients.some((c) => !featuredIds.has(c.id) && c.id !== "generic");
}

function tileCount(data: ConnectPageData) {
  return data.featuredClients.length + (hasOtherAgents(data) ? 1 : 0);
}

function AgentTiles({
  data,
  selected,
  connectedIds,
  onPick,
}: {
  data: ConnectPageData;
  selected: ConnectClient;
  connectedIds: Set<string>;
  onPick: (id: string) => void;
}) {
  const featuredIds = new Set(data.featuredClients.map((c) => c.id));
  // Generic client and every non-featured agent live behind the one tile, which
  // then shows the app you picked there.
  const otherPicked = featuredIds.has(selected.id) ? null : selected;
  const showOther = hasOtherAgents(data) || !!otherPicked;
  const count = data.featuredClients.length + (showOther ? 1 : 0);
  // An admin limit of 1 to 3 agents: one row of fixed-width tiles, a little
  // roomier, centered both ways in the space two grid rows would take, with
  // no box around it.
  const row = count <= ROW_MAX;
  const iconSize = row ? 40 : 34;
  return (
    <div
      className={cn(
        "mt-3 max-w-xl gap-2.5",
        row
          ? "flex min-h-[10.75rem] items-center justify-center [&>*]:w-36"
          : "grid grid-cols-4",
      )}
    >
      {data.featuredClients.map((c) => (
        <Tile
          key={c.id}
          roomy={row}
          active={c.id === selected.id}
          connected={connectedIds.has(c.id)}
          onClick={() => onPick(c.id)}
          icon={<ClientIcon client={c} size={iconSize} />}
          label={c.label}
        />
      ))}
      {showOther && (
        <AgentSearch
          data={data}
          selectedId={selected.id}
          connectedIds={connectedIds}
          onPick={onPick}
        >
          <Tile
            roomy={row}
            active={!!otherPicked}
            connected={
              otherPicked
                ? connectedIds.has(otherPicked.id)
                : [...connectedIds].some((id) => !featuredIds.has(id))
            }
            aria-label={
              otherPicked
                ? `${labelOf(otherPicked)}, change agent`
                : "Other agents"
            }
            icon={
              otherPicked ? (
                <span key={otherPicked.id} className="v8-icon">
                  <ClientIcon client={otherPicked} size={iconSize} />
                </span>
              ) : (
                <span
                  className="flex items-center justify-center rounded-lg border border-dashed text-muted-foreground"
                  style={{ width: iconSize, height: iconSize }}
                >
                  <MoreHorizontal className="size-4" />
                </span>
              )
            }
            // The chevron says this tile reopens the list, picked or not.
            label={
              <>
                {otherPicked ? labelOf(otherPicked) : "Other agents"}
                <ChevronDown className="ml-0.5 inline size-3 align-[-2px] opacity-60" />
              </>
            }
          />
        </AgentSearch>
      )}
    </div>
  );
}

function Tile({
  roomy,
  active,
  connected,
  icon,
  label,
  sub,
  onClick,
  ...rest
}: {
  active: boolean;
  connected: boolean;
  icon: ReactNode;
  label: ReactNode;
  /** One small line under the label, shown in full. */
  sub?: string;
  roomy?: boolean;
  onClick?: () => void;
} & ComponentProps<"button">) {
  return (
    <UnstyledButton
      type="button"
      onClick={onClick}
      aria-pressed={active}
      {...rest}
      className={cn(
        "relative flex min-w-0 flex-col items-center gap-2 rounded-xl border bg-card px-2 text-xs transition-[border-color,background-color,transform] duration-200 hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-safe:hover:-translate-y-0.5",
        roomy ? "pt-4 pb-3 text-[13px]" : "pt-3 pb-2.5",
        active
          ? "border-primary bg-muted/40 font-medium text-foreground ring-1 ring-primary"
          : "text-muted-foreground",
      )}
    >
      {icon}
      {/* Labels wrap to two lines rather than truncate. */}
      <span className="line-clamp-2 w-full text-center leading-tight break-words">
        {label}
      </span>
      {sub && (
        <span className="-mt-1 w-full text-center text-[11px] leading-tight font-normal text-muted-foreground">
          {sub}
        </span>
      )}
      {connected && (
        <span
          className="absolute top-1.5 right-1.5 grid size-4 place-items-center rounded-full bg-emerald-500 text-white"
          title="Connected"
        >
          <Check className="size-2.5" strokeWidth={3} />
          <span className="sr-only">Connected</span>
        </span>
      )}
    </UnstyledButton>
  );
}

// === Connect area: prompt, or the manual steps in its place ===

function ConnectArea({
  data,
  client,
  setup,
  status,
  step,
  manual,
  scriptable,
  script,
  choices,
  prompt,
  firstPrompt,
  includeLabel,
  onInclude,
  onManual,
  onCopied,
  onCursorNote,
  onDisconnect,
  onConnectAnother,
  footprint,
  skillCount,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  setup: SetupMode;
  status: Status;
  step: CurrentStep;
  manual: boolean;
  /** The app has an installer, so it offers Prompt / Script. */
  scriptable: boolean;
  /** Script is chosen: show the installer command instead of the prompt. */
  script: boolean;
  choices: ConnectChoices;
  /** null when every part is left out. */
  prompt: string | null;
  firstPrompt: string | null;
  includeLabel: string;
  onInclude: () => void;
  onManual: (v: boolean) => void;
  onCopied: () => void;
  onCursorNote: () => void;
  onDisconnect: () => void;
  /** Set while connected: start a new connection, e.g. on another machine. */
  onConnectAnother?: () => void;
  footprint: ConnectFootprint;
  skillCount: number;
}) {
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  // Claude Code, Codex and OpenCode: copying opens a short setup window for
  // this user, so the agent's setup can start without another sign-in.
  const sessionClientId: NativeSessionClientId | undefined =
    hasNativeSetupSession(client.id) ? client.id : undefined;
  const session = useConnectionPromptSession(sessionClientId, origin);
  const [windows, setWindows] = useState(false);
  useEffect(() => setWindows(detectPlatform() === "windows"), []);
  const command = scriptable
    ? data.installerCommand(client, choices, windows)
    : null;
  // What the box shows and the button copies.
  const text = script ? command : prompt;
  const copy = async () => {
    if (!text) return;
    try {
      // The terminal command asks for browser approval itself.
      if (sessionClientId && !script) {
        const refreshed = await session.refetch();
        if (
          refreshed.isError ||
          !refreshed.data ||
          Date.parse(refreshed.data.expiresAt) <= Date.now()
        ) {
          toast.error("Could not start connection setup. Try again.");
          return;
        }
      }
      await copyToClipboard(text);
      setCopied(true);
      onCopied();
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy. Select the prompt and copy it manually.");
    }
  };
  const generic = setup === "prompt-or-manual";
  const disconnectNote = (
    <span className="text-muted-foreground">
      You can{" "}
      <UndoDialog data={data} client={client}>
        disconnect at any time
      </UndoDialog>
      .
    </span>
  );

  if (status === "connected") {
    return (
      <Band
        tone="connected"
        className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
      >
        <StepHeading step={step} />
        {firstPrompt ? (
          <div className="mt-4">
            <div className="mb-2 text-sm text-muted-foreground">
              Try this in a new {nameOf(client)} session:
            </div>
            <CopyLine text={firstPrompt} label="Copy" primary />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Start a new {nameOf(client)} session to pick up the changes.
          </p>
        )}
        <BandFooter>
          {onConnectAnother && (
            <MetaButton icon={<Plus />} onClick={onConnectAnother}>
              Connect on another machine
            </MetaButton>
          )}
          <MetaButton
            icon={<Unplug />}
            onClick={onDisconnect}
            className="md:ml-auto"
          >
            Disconnect {labelOf(client)}
          </MetaButton>
        </BandFooter>
      </Band>
    );
  }

  return (
    <Band tone="current" busy={data.revalidating}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <StepHeading step={step} />
        {setup === "prompt-or-manual" && (
          <ModeSwitch
            alt={manual}
            altIcon={<ListOrdered />}
            altLabel="Manual setup"
            onChange={onManual}
          />
        )}
        {scriptable && (
          <ModeSwitch
            alt={script}
            altIcon={<SquareTerminal />}
            altLabel="Script"
            onChange={onManual}
          />
        )}
        {setup === "manual" && (
          <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
            Manual setup only
          </span>
        )}
      </div>

      {manual ? (
        // The steps take the prompt's place, starting right here.
        <div
          key={`manual-${client.id}`}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-300"
        >
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>Copy each block into {nameOf(client)}, top to bottom.</span>
            <UndoDialog data={data} client={client} />
          </div>
          <ManualSteps client={client} data={data} />
        </div>
      ) : (
        <>
          {/* What happens next, right above the prompt it's about. */}
          <div className="mt-2 space-y-1 px-1 text-xs text-muted-foreground">
            {script ? (
              status === "waiting" ? (
                <p className="text-foreground">
                  Run it, approve the browser page it opens, then follow the
                  next steps below. {disconnectNote}
                </p>
              ) : (
                <p>
                  Run it in a terminal on the computer where you use{" "}
                  {nameOf(client)}. It needs Node.js 18 or newer, opens a
                  browser page, and changes nothing until you approve.{" "}
                  {disconnectNote}
                </p>
              )
            ) : status === "waiting" ? (
              <p className="text-foreground">
                {generic
                  ? `Paste it into ${nameOf(client)}, then say yes when it asks.`
                  : `Paste it into ${nameOf(client)}, then approve the browser page it opens.`}{" "}
                {disconnectNote}
              </p>
            ) : (
              <p>
                {nameOf(client) === "your agent"
                  ? "Your agent"
                  : nameOf(client)}{" "}
                {generic
                  ? "checks what it supports and asks before changing anything."
                  : "opens a browser page. Nothing changes until you approve."}{" "}
                {disconnectNote}
              </p>
            )}
            {client.id === "cursor" && (
              <p className="flex items-center gap-1.5">
                <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
                Cursor keeps its own models. Routing them through {data.appName}{" "}
                takes one manual step after setup.
                <UnstyledButton
                  type="button"
                  onClick={onCursorNote}
                  className="rounded-sm underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  How
                </UnstyledButton>
              </p>
            )}
          </div>

          <div className="mt-2 flex h-16 items-center gap-3 rounded-2xl border bg-background pr-2 pl-5 shadow-sm">
            <Terminal className="size-4 shrink-0 text-muted-foreground" />
            <code
              className={cn(
                "min-w-0 flex-1 truncate font-mono text-sm",
                !text && "font-sans text-muted-foreground",
              )}
              title={text ?? undefined}
            >
              {text ??
                "Everything is left out. Choose at least one thing to include."}
            </code>
            <Button
              size="lg"
              onClick={copy}
              disabled={!text || !origin || data.revalidating}
              className="h-12 shrink-0 rounded-xl px-6 text-base"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : script ? "Copy command" : "Copy prompt"}
            </Button>
          </div>

          {script && (
            <div className="mt-3 grid gap-x-8 gap-y-2 px-1 text-xs text-muted-foreground md:grid-cols-[minmax(0,1fr)_auto]">
              <div>
                <p className="font-medium text-foreground">When it finishes</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                  {scriptNextSteps(client).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  <li>
                    The full next steps are printed at the end of the output.
                  </li>
                </ol>
              </div>
              <UnstyledButton
                type="button"
                onClick={() => setWindows(!windows)}
                className="self-start rounded-sm underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {windows
                  ? "Use the macOS / Linux command"
                  : "Use the Windows command"}
              </UnstyledButton>
            </div>
          )}

          {/* Footer: what to include, and what it adds. */}
          <BandFooter>
            <MetaButton icon={<SlidersHorizontal />} onClick={onInclude}>
              {includeLabel}
            </MetaButton>
            {/* Other agents use the admin's default gateway and read the
                endpoint from the prompt; apps with an installer pick both on
                the approval page. */}
            {generic && data.baseUrls.length > 1 && (
              <EndpointPicker data={data} />
            )}
            <span className="md:ml-auto">
              {footprintSummary(client, footprint, skillCount)}
            </span>
          </BandFooter>
        </>
      )}
    </Band>
  );
}

/** Picks the endpoint other agents connect to, when the admin offers several. */
function EndpointPicker({ data }: { data: ConnectPageData }) {
  const describe = new Map(
    (data.baseUrlMetadata ?? []).map((m) => [m.url, m.description] as const),
  );
  return (
    <Select value={data.baseUrl} onValueChange={data.selectBaseUrl}>
      <SelectTrigger
        size="sm"
        aria-label="Endpoint"
        className="h-7 max-w-72 gap-1.5 text-xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {data.baseUrls.map((url) => (
          <SelectItem key={url} value={url} className="text-xs">
            <code className="font-mono">{url}</code>
            {describe.get(url) && (
              <span className="text-muted-foreground">{describe.get(url)}</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** What connecting writes, from the footprint, in plain words. */
function footprintSummary(
  client: ConnectClient,
  fp: ConnectFootprint,
  skillCount: number,
) {
  const files = fp.skillsInstalled > 0 ? skillCount : 0;
  const skills =
    files > 0 ? ` and ${fmt(files)} skill ${plural(files, "file")}` : "";
  return `Adds 1 MCP entry${skills} to ${nameOf(client)}.`;
}

/**
 * What to do once the installer finishes, short. The setup script prints the
 * full list (nextStepsFor in backend/src/services/connection-setup-script.ts).
 */
function scriptNextSteps(client: ConnectClient): string[] {
  switch (client.id) {
    case "claude-code":
      return [
        "Open a new terminal and start claude.",
        "Run /mcp, pick the gateway and sign in through the browser. Skills load on their own.",
      ];
    case "cursor":
      return [
        "Reload Cursor.",
        "Open Customize > MCPs and sign in to the gateway.",
        'If the output shows "Cursor model settings", enter them under Settings > Models > API Keys.',
      ];
    case "codex":
      return [
        "Open a new terminal and run codex.",
        'If the output doesn\'t say "Successfully logged in.", run the codex mcp login command it prints.',
        "For skills, run /plugins and install the plugin.",
      ];
    case "copilot-cli":
      return [
        "Restart Copilot. It opens the browser to sign in to the gateway.",
        "If the output prints export lines, add them to your shell profile.",
      ];
    case "opencode":
      return [
        "Close OpenCode and start it again in a new terminal.",
        "If the gateway isn't connected, run the opencode mcp auth command it prints.",
      ];
    default:
      return [`Restart ${nameOf(client)}.`];
  }
}

// === Connect band heading: the one instruction ===

type StepKind = "current" | "waiting" | "connected";

interface CurrentStep {
  kind: StepKind;
  text: string;
}

function currentStep(
  client: ConnectClient,
  status: Status,
  manual: boolean,
  script: boolean,
): CurrentStep {
  const name = nameOf(client);
  const Name = name === "your agent" ? "Your agent" : name;
  if (status === "connected")
    return { kind: "connected", text: `Connected. ${Name} is ready to use` };
  if (status === "waiting")
    return { kind: "waiting", text: `Waiting for ${name}` };
  if (manual) return { kind: "current", text: `Follow the steps for ${name}` };
  if (script)
    return { kind: "current", text: "Run the command in your terminal" };
  return { kind: "current", text: `Paste the prompt into ${name}` };
}

function StepMarker({ kind }: { kind: StepKind }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5",
        kind === "connected"
          ? "bg-emerald-500 text-white"
          : "bg-primary text-primary-foreground",
      )}
    >
      {kind === "connected" ? (
        <Check strokeWidth={3} />
      ) : kind === "waiting" ? (
        <span className="size-2 rounded-full bg-primary-foreground motion-safe:animate-pulse" />
      ) : (
        <ArrowDown strokeWidth={2.5} />
      )}
    </span>
  );
}

function Band({
  tone,
  busy,
  className,
  children,
}: {
  tone: "current" | "connected";
  /** Settings are being re-read: hold actions until they land. */
  busy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // Same accent as the heading's marker.
  return (
    <section
      aria-label="Connect"
      aria-busy={busy}
      inert={busy}
      className={cn(
        "mt-6 rounded-3xl border bg-card/80 p-5 shadow-sm transition-colors duration-300 md:px-7 md:py-6",
        tone === "connected"
          ? "border-emerald-500/35 ring-1 ring-emerald-500/15"
          : "border-primary/40 ring-1 ring-primary/15",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** The band's last line: quiet controls, separated from the action above. */
function BandFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-1 pt-3 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function StepHeading({ step }: { step: CurrentStep }) {
  return (
    <h2
      key={step.text}
      className="inline-flex items-center gap-2.5 text-base font-semibold tracking-tight motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
    >
      <StepMarker kind={step.kind} />
      {step.text}
    </h2>
  );
}

function ManualSteps({
  client,
  data,
}: {
  client: ConnectClient;
  data: ConnectPageData;
}) {
  const steps = useManualSteps(client, {
    gatewayId: data.gateway?.id,
    baseUrl: data.baseUrl,
    onBaseUrlChange: data.selectBaseUrl,
  });
  if (steps.length === 0)
    return (
      <p className="mt-4 rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">
        Manual setup isn't available for your account. Ask your admin for access
        to the MCP gateway.
      </p>
    );
  return (
    <ol className="mt-4 flex flex-col rounded-2xl border bg-background p-6 md:p-8">
      {steps.map((s, i) => (
        <li
          key={s.key}
          className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-4 pb-9 last:pb-0"
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
            <h3 className="pt-1 text-sm font-medium">{s.title}</h3>
            <div className="mt-3 min-w-0 max-w-5xl">{s.content}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function MetaButton({
  icon,
  children,
  onClick,
  className,
  ...rest
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
} & ComponentProps<"button">) {
  return (
    <UnstyledButton
      type="button"
      onClick={onClick}
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm tabular-nums underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5",
        className,
      )}
    >
      {icon}
      {children}
    </UnstyledButton>
  );
}

/** Prompt, or the app's other way in (Manual setup or Script). */
function ModeSwitch({
  alt,
  altIcon,
  altLabel,
  onChange,
}: {
  alt: boolean;
  altIcon: ReactNode;
  altLabel: string;
  onChange: (alt: boolean) => void;
}) {
  const option = (value: boolean, icon: ReactNode, label: string) => (
    <UnstyledButton
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={alt === value}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors [&_svg]:size-3.5",
        alt === value
          ? "bg-background font-medium text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </UnstyledButton>
  );
  return (
    <div className="inline-flex rounded-lg border bg-muted/60 p-0.5">
      {option(false, <MessageSquareText />, "Prompt")}
      {option(true, altIcon, altLabel)}
    </div>
  );
}

// === Profile card ===

const SERVER_ROWS = 6;
const SKILL_ROWS = 6;

interface StatusChip {
  id: string;
  icon: ReactNode;
  title: string;
  sub: ReactNode;
  onOpen: () => void;
}

function ProfileCard({
  data,
  client,
  status,
  servers,
  tools,
  skills,
  skillCount,
  onOpen,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  status: Status;
  servers: ConnectServer[];
  tools: number;
  skills: ConnectPageSkill[];
  skillCount: number;
  onOpen: (d: DialogKind, server?: string) => void;
}) {
  const on = status === "connected";
  const gatewayName = data.gateway?.name;
  const plus = on ? "" : "+";
  const skillsOn = data.skillsEnabled && data.totalSkills > 0;

  // Small status chips under the lists. A future capability is one entry.
  const statusChips: StatusChip[] = [];
  if (data.llmProxyEnabled)
    statusChips.push({
      id: "routing",
      icon: (
        <ChipIcon>
          <Cpu />
        </ChipIcon>
      ),
      title: "Same models",
      sub: `Requests go through ${data.appName}`,
      onOpen: () => onOpen("routing"),
    });
  if (data.guardrails.enabled)
    statusChips.push({
      id: "guardrails",
      icon: (
        <ChipIcon tone="ok">
          <ShieldCheck />
        </ChipIcon>
      ),
      title: `${data.guardrails.name} guardrails`,
      sub: (
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" strokeWidth={3} />
          Active
        </span>
      ),
      onOpen: () => onOpen("guardrails"),
    });

  return (
    <aside
      aria-label={`What ${labelOf(client)} gets`}
      className="relative min-w-0 rounded-3xl border bg-card p-5 shadow-sm lg:mt-2"
    >
      <div className="flex items-center gap-3.5">
        <div key={`icon-${client.id}`} className="v8-icon">
          <ClientIcon client={client} size={44} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-semibold tracking-tight">
            {labelOf(client)}
          </div>
          <StatusLine status={status} />
        </div>
      </div>

      {/* One short line; the lists below speak for themselves. */}
      <p className="mt-4 text-[15px] leading-snug text-pretty text-foreground">
        {cardIntro(data, servers, skillsOn ? skillCount : 0)}
      </p>

      {/* Capability blocks: they stack in once on page load and stay put when
          another agent is picked (only the header animates per pick). */}
      <div className="mt-2.5">
        <ul className="flex flex-col gap-2">
          <li className="v8-chip relative" style={{ animationDelay: "140ms" }}>
            {data.servers.length === 0 ? (
              <ListBlock
                icon={<Wrench />}
                title="Tools on the way"
                sub="They show up here when your admin adds MCP servers"
                muted
              />
            ) : (
              <ListBlock
                icon={<Wrench />}
                title={`${plus}${fmt(tools)} ${plural(tools, "tool")}`}
                sub={
                  <>
                    from {fmt(servers.length)} MCP{" "}
                    {plural(servers.length, "server")}
                    <InfoTip label="What MCP servers are">
                      Tools your agent calls, served through your organization's
                      gateway
                      {gatewayName ? ` (${gatewayName})` : ""}.
                    </InfoTip>
                  </>
                }
                more={
                  servers.length > SERVER_ROWS
                    ? `See all ${fmt(servers.length)}`
                    : "See all"
                }
                onMore={() => onOpen("servers")}
              >
                {servers.length === 0 ? (
                  <span className="block py-1 text-muted-foreground">
                    Every server is left out.
                  </span>
                ) : (
                  <span className="grid grid-cols-2 gap-x-2">
                    {servers.slice(0, SERVER_ROWS).map((s) => (
                      <UnstyledButton
                        key={s.key}
                        type="button"
                        onClick={() => onOpen("servers", s.key)}
                        title={`View ${s.name} tools`}
                        className="group/row -mx-1.5 flex h-6.5 min-w-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <McpCatalogIcon
                          icon={s.icon}
                          catalogId={s.catalogId ?? undefined}
                          size={15}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {s.name}
                        </span>
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover/row:text-foreground motion-safe:group-hover/row:translate-x-0.5" />
                      </UnstyledButton>
                    ))}
                  </span>
                )}
              </ListBlock>
            )}
          </li>

          {skillsOn && (
            <li
              className="v8-chip relative"
              style={{ animationDelay: "250ms" }}
            >
              <ListBlock
                icon={<BookOpen />}
                title={`${plus}${fmt(skillCount)} ${plural(skillCount, "skill")}`}
                sub="loaded when a task needs one"
                more={
                  skillCount > SKILL_ROWS
                    ? `See all ${fmt(skillCount)}`
                    : "See all"
                }
                onMore={() => onOpen("skills")}
              >
                {skills.length === 0 ? (
                  <span className="block py-1 text-muted-foreground">
                    Every skill is left out.
                  </span>
                ) : (
                  <span className="grid grid-cols-2 gap-x-2">
                    {skills.slice(0, SKILL_ROWS).map((s) => (
                      <span
                        key={s.id}
                        title={s.description}
                        className="flex h-6 min-w-0 items-center truncate font-mono text-[11px] text-foreground"
                      >
                        {s.name}
                      </span>
                    ))}
                  </span>
                )}
              </ListBlock>
            </li>
          )}

          {statusChips.length > 0 && (
            <li
              className="v8-chip relative"
              style={{ animationDelay: "360ms" }}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {statusChips.map((c) => (
                  <UnstyledButton
                    key={c.id}
                    type="button"
                    onClick={c.onOpen}
                    className="flex min-w-0 items-center gap-2.5 rounded-xl border bg-background py-2 pr-3 pl-2 text-left transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {c.icon}
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold tracking-tight">
                        {c.title}
                      </span>
                      <span className="block text-xs leading-snug text-muted-foreground">
                        {c.sub}
                      </span>
                    </span>
                  </UnstyledButton>
                ))}
              </div>
            </li>
          )}
        </ul>
      </div>

      {/* Footer: what it costs. */}
      <div className="mt-4 space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="flex min-w-0 items-center gap-2">
            <Gauge className="size-3.5 shrink-0" />
            <span>{toolLoading(data, tools)}</span>
          </span>
          <InfoTip label="How tools load">
            {data.progressive
              ? "Your agent starts with a small fixed set of tools and finds the rest when a task needs them. Adding servers doesn't grow it."
              : "Every included tool loads at the start of each session. More tools take more of your agent's working memory."}
          </InfoTip>
        </div>
      </div>
    </aside>
  );
}

function ListBlock({
  icon,
  title,
  sub,
  muted,
  more,
  onMore,
  children,
}: {
  icon: ReactNode;
  title: string;
  sub: ReactNode;
  muted?: boolean;
  more?: string;
  onMore?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-background py-2 pr-3.5 pl-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <ChipIcon>{icon}</ChipIcon>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span
            className={cn(
              "text-[15px] font-semibold tracking-tight tabular-nums",
              muted && "text-muted-foreground",
            )}
          >
            {title}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {sub}
          </span>
        </span>
        {more && onMore && (
          <UnstyledButton
            type="button"
            onClick={onMore}
            className="shrink-0 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {more}
          </UnstyledButton>
        )}
      </div>
      {children && (
        <div className="mt-1.5 border-t pt-1 pl-1 text-xs">{children}</div>
      )}
    </div>
  );
}

/** The gateway the admin picked, then the lists; empty states in words. */
function cardIntro(
  data: ConnectPageData,
  servers: ConnectServer[],
  skillCount: number,
): ReactNode {
  if (servers.length > 0 || skillCount > 0)
    return data.gateway ? (
      <>
        Connects to <span className="font-semibold">{data.gateway.name}</span>,
        which gives it:
      </>
    ) : (
      "Connects to your organization's gateway, which gives it:"
    );
  if (data.servers.length === 0)
    return "Your agent gets your company's tools here as soon as your admin adds them.";
  return "You left out every tool and skill, so your agent gets nothing yet.";
}

function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          type="button"
          aria-label={label}
          className="inline-grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Info className="size-3" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">{children}</TooltipContent>
    </Tooltip>
  );
}

function ChipIcon({ children, tone }: { children: ReactNode; tone?: "ok" }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border [&_svg]:size-4",
        tone === "ok"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status === "connected")
    return (
      <span className="mt-1 flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Connected
      </span>
    );
  if (status === "waiting")
    return (
      <span className="mt-1 flex items-center gap-1.5 text-sm text-foreground">
        <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
        Waiting for approval
      </span>
    );
  return (
    <span className="mt-1 block text-sm text-muted-foreground">
      Not connected yet
    </span>
  );
}

// === Loading ===

function LoadingState() {
  return (
    <div className="mx-auto w-full max-w-7xl px-6 pt-12 md:px-10 lg:px-14">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,29rem)] lg:gap-12 xl:grid-cols-[minmax(0,1fr)_minmax(0,31rem)] xl:gap-16">
        <div className="space-y-5">
          <Skeleton className="h-16 w-80 max-w-full" />
          <Skeleton className="h-16 w-64 max-w-full" />
          <Skeleton className="h-6 w-[30rem] max-w-full" />
          <Skeleton className="mt-8 h-24 max-w-xl rounded-xl" />
        </div>
        <Skeleton className="h-[400px] rounded-3xl" />
      </div>
      <Skeleton className="mt-8 h-36 rounded-3xl" />
    </div>
  );
}
