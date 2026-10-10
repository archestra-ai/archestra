"use client";

// The Connect page.
// The connect band below the hero carries the instruction as its heading,
// with one marker and one accent, so it reads as the next thing to do.
// A split hero, then a full-width connect band. Hero left: the headline and
// the agent picker (featured apps plus one "Other agents" tile that becomes
// the picked app, in place; with 1 to 3 tiles they sit in one row, centered
// in the picker area, unboxed). Hero right: a compact profile card for the
// chosen agent: light server and skill rows, then status chips (routing,
// guardrails). A future capability (budgets, audit...) is one more entry in
// `statusChips` in ProfileCard.
// Under the hero, spanning the page: the app's way in. The installer command
// for apps with one, Claude Desktop's download, the copy prompt for other
// agents, or the manual steps themselves.

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import {
  ArrowDown,
  BookOpen,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Gauge,
  Info,
  MoreHorizontal,
  Puzzle,
  Settings,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useConnectedSignal } from "@/lib/connect-signal";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { cn } from "@/lib/utils/tailwind";
import {
  AfterConnect,
  type AfterConnectPhase,
  type AfterConnectRun,
} from "./after-connect";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";
import {
  ALL_INCLUDED,
  type ConnectChoices,
  type ConnectPicks,
  DEFAULT_PICKS,
  readConnectChoices,
  readConnectPicks,
  saveConnectChoices,
} from "./connect-choices";
import {
  type ConnectPageData,
  type ConnectPageSkill,
  type ConnectPlugin,
  type ConnectServer,
  useConnectPageData,
  welcomePrompt,
} from "./connect-page-data";
import {
  AgentSearch,
  approxTokens,
  BrowseDialog,
  fmt,
  InfoDialog,
  nameOf,
  PromptRow,
  plural,
  sentenceNameOf,
  TextButton,
  useCopy,
} from "./connect-page-parts";
import {
  type ConnectedAgent,
  DisconnectLine,
  LastConnectedMark,
  useConnectedAgents,
} from "./connected-agents";
import { type IncludeChange, IncludeDialog } from "./include-dialog";
import {
  readsPrompts,
  type SetupMode,
  setupModeFor,
  useManualSteps,
} from "./manual-setup";
import { detectPlatform } from "./platform.utils";
import { useUpdateUrlParams } from "./use-update-url-params";

// The approval panel is large; the page only needs it for Claude Desktop's
// installer download, so it loads on demand.
const ConnectCommandPanel = dynamic(
  () => import("./connect-command-panel").then((m) => m.ConnectCommandPanel),
  { ssr: false },
);

type DialogKind = "servers" | "skills" | "plugins" | "cursor" | "include";

const MOTION_CSS = `
@keyframes connect-icon {
  0% { opacity: 0.3; transform: scale(0.78) rotate(-8deg); }
  60% { opacity: 1; transform: scale(1.07) rotate(2deg); }
  100% { opacity: 1; transform: none; }
}
.connect-icon { animation: connect-icon 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
@media (prefers-reduced-motion: reduce) {
  .connect-icon { animation: none; }
}
`;

export function ConnectPage() {
  usePageTitle("Connect");
  // A gateway and plugins picked over the defaults, per agent, kept next to
  // the switches below.
  const [picks, setPicks] = useState<ConnectPicks>(DEFAULT_PICKS);
  const connected = useConnectedAgents();
  // Same access as the Agent connections log it links to.
  const { data: canSeeStatistics } = useHasPermissions(
    requiredPagePermissionsMap["/connections/logs"] ?? {},
  );
  // Links (connect.md, docs) can open the page on an app. Picks are written
  // back.
  const searchParams = useSearchParams();
  const updateUrlParams = useUpdateUrlParams();
  const [pickedId, setPickedId] = useState(() => searchParams.get("clientId"));
  const data = useConnectPageData(pickedId, picks.gatewayId);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  // What the user leaves out, per agent. The copied command (or prompt, for
  // generic agents) carries it, and this browser keeps it for a while
  // (connect-choices.ts).
  const [choices, setChoices] = useState<ConnectChoices>(ALL_INCLUDED);

  const skillsSorted = useMemo(
    () => [...data.skills].sort((a, b) => b.usageCount - a.usageCount),
    [data.skills],
  );

  const client =
    data.clients.find((c) => c.id === pickedId) ??
    data.clients.find((c) => c.id === data.defaultClientId) ??
    data.featuredClients[0] ??
    data.clients[0];
  const clientId = client?.id;
  useEffect(() => {
    // Tools are always included; skills, plugins and model routing can be
    // left out (Choose what to include).
    if (!clientId) return;
    setChoices({ ...readConnectChoices(clientId), tools: true });
    setPicks(readConnectPicks(clientId));
  }, [clientId]);

  if (data.loading || !client) return <LoadingState />;

  const parts = data.partsFor(client);
  const routed = parts.proxy && choices.proxy;
  const servers = choices.tools ? data.servers : [];
  const tools = choices.tools ? data.totalTools : 0;
  const skills = data.skillsEnabled ? skillsSorted : [];
  const plugins = parts.plugins
    ? data.keptPlugins(client, picks.pluginIds)
    : [];
  const prompt = data.connectPrompt(client, choices);
  const update = (change: IncludeChange) => {
    const nextChoices = { ...choices, ...change.choices };
    const nextPicks = { ...picks, ...change.picks };
    setChoices(nextChoices);
    setPicks(nextPicks);
    saveConnectChoices(client.id, nextChoices, nextPicks);
  };

  const setup = setupModeFor(client);
  const step = currentStep(client, setup);

  const pick = (id: string) => {
    setPickedId(id);
    // Manual steps bookmark a provider; providers vary per app.
    updateUrlParams({ clientId: id, mode: null, providerId: null });
  };

  return (
    <div className="relative w-full overflow-hidden text-foreground">
      <style>{MOTION_CSS}</style>
      <DotField />

      {/* The layout follows the room left by the sidebar, not the window. */}
      <div className="@container relative mx-auto w-full max-w-7xl px-6 pt-10 pb-16 md:px-10 lg:px-14 lg:pt-12">
        {(data.canManage || canSeeStatistics) && (
          <div className="absolute top-4 right-6 flex gap-2 md:right-10 lg:right-14">
            {canSeeStatistics && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="shadow-xs dark:bg-background"
              >
                <Link href="/connections/logs">
                  <ChartColumn />
                  Statistics
                </Link>
              </Button>
            )}
            {data.canManage && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="shadow-xs dark:bg-background"
              >
                <Link href="/settings/connection">
                  <Settings />
                  Settings
                </Link>
              </Button>
            )}
          </div>
        )}

        <header className="mx-auto max-w-3xl pt-4 text-center">
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-tighter text-balance md:text-5xl">
            Connect your agent to {data.appName}
          </h1>
          <p className="mx-auto mt-3 max-w-[40rem] text-sm leading-relaxed text-muted-foreground">
            The MCP servers and skills your organization runs for itself, now
            usable in your agent of choice.
          </p>
        </header>

        {/* One column, top to bottom: pick, what it gets, connect. A thin line
            runs down from the picked tile through both steps. */}
        <div className="relative mt-6">
          <div className="flex items-end justify-between gap-3">
            <h2 className="text-sm font-semibold">
              {tileCount(data) === 1 ? "Your agent" : "Pick your agent"}
            </h2>
            <DisconnectLine
              data={data}
              picked={client}
              agents={connected.agents}
            />
          </div>
          <AgentTiles
            data={data}
            selected={client}
            lastConnected={connected.lastConnected}
            onPick={pick}
          />

          <div aria-hidden style={{ height: STEP_GAP }} />
          <ProfileCard
            data={data}
            client={client}
            servers={servers}
            tools={tools}
            skills={skills}
            skillsOff={parts.skills && !choices.skills}
            plugins={plugins}
            pluginsOff={
              parts.plugins && (!choices.plugins || plugins.length === 0)
            }
            routed={routed}
            choices={choices}
            onOpen={(d, item) => {
              setFocus(item ?? null);
              setDialog(d);
            }}
          />

          <Connector />
          <ConnectArea
            data={data}
            client={client}
            setup={setup}
            step={step}
            choices={choices}
            picks={picks}
            prompt={prompt}
            onCursorNote={() => setDialog("cursor")}
          />
        </div>
      </div>

      <BrowseDialog
        open={
          dialog === "servers" || dialog === "skills" || dialog === "plugins"
        }
        tab={dialog === "skills" || dialog === "plugins" ? dialog : "servers"}
        focus={focus}
        onTab={(t) => setDialog(t)}
        onOpenChange={(v) => !v && setDialog(null)}
        data={data}
        client={client}
        skills={skillsSorted}
        choices={choices}
      />
      <IncludeDialog
        open={dialog === "include"}
        onOpenChange={(v) => !v && setDialog(null)}
        data={data}
        client={client}
        choices={choices}
        picks={picks}
        onChange={update}
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
            the LLM proxy on in the browser approval. After setup, find "Cursor
            model settings (manual step)" in the installer output: it shows the
            proxy URL and, if chosen, a virtual key. In Cursor Settings, Models,
            API Keys, enter those values and turn on Use OpenAI API Key and
            Override OpenAI Base URL. A Cursor subscription can't be used as a
            key.
          </p>
        </div>
      </InfoDialog>
    </div>
  );
}

// === Background ===

function DotField() {
  // Fades out down the page, and clears behind the headline and picker so
  // the dots never sit under text. Dark mode's border is too faint to see,
  // so its dots use the muted text color, kept low.
  const mask = [
    "radial-gradient(ellipse 45% 55% at 50% 30%, transparent 35%, black 80%)",
    "linear-gradient(to bottom, black 0%, black 45%, transparent 100%)",
  ].join(", ");
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[760px] opacity-50 [--dot:var(--border)] dark:opacity-20 dark:[--dot:var(--muted-foreground)]"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--dot) 1.1px, transparent 1.4px)",
        backgroundSize: "26px 26px",
        maskImage: mask,
        maskComposite: "intersect",
        WebkitMaskImage: mask,
        WebkitMaskComposite: "source-in",
      }}
    />
  );
}

// === Agent picker: the one place to pick ===

// Up to this many tiles sit in one centered row instead of the grid.
const ROW_MAX = 3;

/** Agents offered behind the overflow tile. */
function hasOtherAgents(data: ConnectPageData) {
  const featuredIds = new Set(data.featuredClients.map((c) => c.id));
  return data.clients.some(
    (c) =>
      !featuredIds.has(c.id) && (c.id !== "generic" || data.hasClientOrder),
  );
}

function tileCount(data: ConnectPageData) {
  return data.featuredClients.length + (hasOtherAgents(data) ? 1 : 0);
}

function AgentTiles({
  data,
  selected,
  lastConnected,
  onPick,
}: {
  data: ConnectPageData;
  selected: ConnectClient;
  lastConnected: ConnectedAgent | null;
  onPick: (id: string) => void;
}) {
  const markFor = (id: string) =>
    lastConnected?.clientId === id ? (
      <LastConnectedMark agent={lastConnected} />
    ) : undefined;
  // The tiles stay on one line: featured apps that don't fit fold into the
  // "Other agents" tile, starting from the right.
  const ref = useRef<HTMLDivElement>(null);
  const fits = useTilesThatFit(ref);
  const all = data.featuredClients.length + (hasOtherAgents(data) ? 1 : 0);
  const tiled =
    fits === null || all <= fits
      ? data.featuredClients
      : data.featuredClients.slice(0, Math.max(fits - 1, 0));
  const tiledIds = new Set(tiled.map((c) => c.id));
  // Generic client and every agent without a tile live behind the one tile,
  // which then shows the app you picked there.
  const otherPicked = tiledIds.has(selected.id) ? null : selected;
  const showOther =
    tiled.length < data.featuredClients.length ||
    hasOtherAgents(data) ||
    !!otherPicked;
  const count = tiled.length + (showOther ? 1 : 0);
  // An admin limit of 1 to 3 agents: fixed-width tiles, a little roomier,
  // centered. More share the full width.
  const row = count <= ROW_MAX;
  const iconSize = row ? 40 : 36;
  return (
    <div
      ref={ref}
      className={cn(
        "mt-3 flex justify-center gap-2.5",
        row ? "[&>*]:w-36" : "[&>*]:max-w-44 [&>*]:flex-1 [&>*]:basis-24",
      )}
    >
      {tiled.map((c) => (
        <Tile
          key={c.id}
          roomy={row}
          active={c.id === selected.id}
          onClick={() => onPick(c.id)}
          icon={<ClientIcon client={c} size={iconSize} />}
          label={c.label}
          marker={markFor(c.id)}
        />
      ))}
      {showOther && (
        <AgentSearch
          data={data}
          tiled={tiled}
          selectedId={selected.id}
          lastConnectedId={lastConnected?.clientId}
          onPick={onPick}
        >
          <Tile
            roomy={row}
            active={!!otherPicked}
            marker={otherPicked ? markFor(otherPicked.id) : undefined}
            aria-label={
              otherPicked
                ? `${otherPicked.label}, change agent`
                : "Other agents"
            }
            icon={
              otherPicked ? (
                <span key={otherPicked.id} className="connect-icon">
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
                {otherPicked ? otherPicked.label : "Other agents"}
                <ChevronDown className="ml-0.5 inline size-3 align-[-2px] opacity-60" />
              </>
            }
          />
        </AgentSearch>
      )}
    </div>
  );
}

// A tile's narrowest width (basis-24) and the gap between tiles (gap-2.5).
const TILE_MIN = 96;
const TILE_GAP = 10;

/** How many tiles fit on one line of the picker; null until measured. */
function useTilesThatFit(ref: RefObject<HTMLDivElement | null>) {
  const [fits, setFits] = useState<number | null>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    // No width yet (or no layout, as in tests): show every tile.
    const measure = () =>
      setFits(
        row.clientWidth
          ? Math.max(
              1,
              Math.floor((row.clientWidth + TILE_GAP) / (TILE_MIN + TILE_GAP)),
            )
          : null,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [ref]);
  return fits;
}

function Tile({
  roomy,
  active,
  icon,
  label,
  sub,
  marker,
  onClick,
  ...rest
}: {
  active: boolean;
  icon: ReactNode;
  label: ReactNode;
  /** Pinned to the tile's top-right corner, e.g. the last connected mark. */
  marker?: ReactNode;
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
        "relative flex min-w-0 flex-col items-center justify-center gap-2 rounded-xl border bg-card px-2 text-xs transition-[border-color,background-color,color] duration-200 hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        roomy ? "pt-4 pb-3" : "pt-3.5 pb-3",
        active
          ? // The muted tint is layered over the card fill, so the page's
            // dots never show through a selected tile.
            "border-primary bg-linear-to-b from-muted/40 to-muted/40 font-semibold text-foreground ring-1 ring-primary"
          : "text-muted-foreground hover:bg-linear-to-b hover:from-muted/50 hover:to-muted/50 hover:text-foreground",
      )}
    >
      {marker && <span className="absolute top-1.5 right-1.5">{marker}</span>}
      {icon}
      {/* Labels wrap to two lines rather than truncate. */}
      <span className="line-clamp-2 w-full text-center leading-tight break-words">
        {label}
      </span>
      {sub && (
        <span className="-mt-1 w-full text-center text-xs leading-tight font-normal text-muted-foreground">
          {sub}
        </span>
      )}
    </UnstyledButton>
  );
}

// === Between the steps ===

// Same gap between every step.
const STEP_GAP = 32;

/** The line between the cards, fading in toward the connect card. */
function Connector() {
  return (
    <div
      aria-hidden
      className="mx-auto w-px bg-linear-to-b from-transparent to-primary"
      style={{ height: STEP_GAP }}
    />
  );
}

/** Names a step on its card's top edge, where the connector arrives. */
function StepPill({ children }: { children: ReactNode }) {
  return (
    <span className="absolute top-0 left-1/2 z-10 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-semibold whitespace-nowrap shadow-xs">
      {children}
    </span>
  );
}

// === Connect area: the command, download, prompt or manual steps ===

function ConnectArea({
  data,
  client,
  setup,
  step,
  choices,
  picks,
  prompt,
  onCursorNote,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  setup: SetupMode;
  step: string;
  choices: ConnectChoices;
  picks: ConnectPicks;
  /** The generic prompt; null when every part is left out. */
  prompt: string | null;
  onCursorNote: () => void;
}) {
  const { copied, copy: copyText } = useCopy();
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const [windows, setWindows] = useState(false);
  useEffect(() => setWindows(detectPlatform() === "windows"), []);
  const manual = setup === "manual";
  const script = setup === "script";
  const download = setup === "download";
  const command = script
    ? data.installerCommand(client, choices, windows, picks)
    : null;
  // What the box shows and the button copies.
  const text = script ? command : prompt;
  const keptPlugins = data.keptPlugins(client, picks.pluginIds);
  // Keeping none of the plugins is leaving plugins out.
  const leftOutParts = (
    Object.keys(choices) as (keyof ConnectChoices)[]
  ).filter(
    (part) =>
      !choices[part] ||
      (part === "plugins" &&
        data.partsFor(client).plugins &&
        keptPlugins.length === 0),
  );

  // After copying: the status card under the band. A changed pick or choice
  // sends it back to idle, except once connected.
  const setupKey = [
    client.id,
    script,
    manual,
    download,
    ...leftOutParts,
    data.gateway?.id,
    ...keptPlugins.map((p) => p.id),
  ].join();
  const [run, setRun] = useState<AfterConnectRun>({
    phase: "idle",
    key: setupKey,
    client,
    script,
  });
  const phase =
    run.phase === "connected" || run.key === setupKey ? run.phase : "idle";
  const setPhase = (next: AfterConnectPhase) =>
    setRun({ phase: next, key: setupKey, client, script });
  // Only a copied prompt or command starts it: Manual setup and Claude
  // Desktop's download have nothing to copy.
  const startWaiting = () => {
    if (!manual && !download && text) setPhase("waiting");
  };
  useConnectedSignal(phase === "waiting", () => setPhase("connected"));

  const copy = async () => {
    if (text && (await copyText(text))) startWaiting();
  };

  const band = (
    <Band busy={data.revalidating} dim={phase === "connected"}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <StepHeading step={step} />
      </div>

      {download ? (
        <ConnectCommandPanel
          // Remount on a changed selection; the panel reads it once.
          key={setupKey}
          variant="download"
          client={client}
          exclude={leftOutParts}
          pluginSlugs={
            picks.pluginIds === null
              ? undefined
              : keptPlugins.map((p) => p.slug)
          }
          mcpGateways={data.gateway ? [data.gateway] : null}
          mcpGatewayId={data.gateway?.id ?? null}
          onMcpGatewaySelect={() => {}}
          llmProxyId={data.llmProxyId}
          shownProviders={data.shownProviders}
          urlProvider={null}
          onProviderSelect={() => {}}
          baseUrl={data.baseUrl}
          skillsEnabled={data.skillsEnabled}
          pluginsEnabled={data.pluginsEnabled}
        />
      ) : manual ? (
        // The steps start right here, in the band.
        <div
          key={`manual-${client.id}`}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-300"
        >
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>Copy each block into {nameOf(client)}, top to bottom.</span>
          </div>
          <ManualSteps client={client} data={data} />
        </div>
      ) : (
        <>
          {/* What happens next, right above the prompt it's about. */}
          <div className="mt-2 space-y-1 px-1 text-xs text-muted-foreground">
            {/* One line: what happens, then that it comes off again. */}
            <p>
              {script ? (
                <>
                  Run it in a terminal on the computer where you use{" "}
                  {nameOf(client)}. It needs Node.js 18 or newer, opens a
                  browser page, and changes nothing until you approve.
                </>
              ) : (
                <>
                  {sentenceNameOf(client)} checks what it supports and asks
                  before changing anything.
                </>
              )}
            </p>
            {client.id === "cursor" && (
              <p className="flex items-center gap-1.5">
                <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
                Cursor keeps its own models. Routing them through {data.appName}{" "}
                takes one manual step after setup.
                <TextButton onClick={onCursorNote}>How</TextButton>
              </p>
            )}
          </div>

          {script && command ? (
            <ScriptBlock
              command={command}
              copied={copied}
              disabled={!origin || data.revalidating}
              onCopy={copy}
              onSelectionCopy={startWaiting}
            />
          ) : (
            <PromptRow
              className="mt-2"
              text={text}
              placeholder="Everything is left out. Choose at least one thing to include."
              copied={copied}
              disabled={!origin || data.revalidating}
              onCopy={copy}
              // Copying the selected text counts like the button.
              onSelectionCopy={startWaiting}
            />
          )}

          {script && (
            <div className="mt-3 grid gap-x-8 gap-y-2 px-1 text-xs text-muted-foreground md:grid-cols-[minmax(0,1fr)_auto]">
              <div>
                <p className="font-semibold text-foreground">
                  When it finishes
                </p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                  {scriptNextSteps(client).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  <li>
                    The full next steps are printed at the end of the output.
                  </li>
                </ol>
              </div>
              <TextButton
                onClick={() => setWindows(!windows)}
                className="self-start"
              >
                {windows
                  ? "Use the macOS / Linux command"
                  : "Use the Windows command"}
              </TextButton>
            </div>
          )}
        </>
      )}
    </Band>
  );

  return (
    <>
      {band}
      <AfterConnect
        phase={phase}
        client={run.client}
        script={run.script}
        welcome={origin ? welcomePrompt(origin, data.appName) : null}
        // n8n has no agent to follow up with; "everything left out" has
        // nothing to follow up on.
        showLink={
          readsPrompts(client) && (setup !== "prompt" || prompt !== null)
        }
        onPhase={setPhase}
      />
    </>
  );
}

/**
 * The installer command on two lines after a dim prompt, in the page's own
 * colours. Copy takes the text exactly as shown.
 */
function ScriptBlock({
  command,
  copied,
  disabled,
  onCopy,
  onSelectionCopy,
}: {
  command: string;
  copied: boolean;
  disabled: boolean;
  onCopy: () => void;
  /** The command text was selected and copied by hand. */
  onSelectionCopy: () => void;
}) {
  return (
    <div className="relative mt-2 rounded-2xl border bg-background shadow-sm">
      <Button
        size="xs"
        variant="ghost"
        onClick={onCopy}
        disabled={disabled}
        className="absolute top-2.5 right-2.5 text-muted-foreground"
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <pre
        onCopy={onSelectionCopy}
        className="overflow-x-auto py-4 pr-24 pl-5 font-mono text-sm leading-relaxed"
      >
        <span className="text-muted-foreground select-none">$ </span>
        {command}
      </pre>
    </div>
  );
}

/**
 * The Script option's "When it finishes" list. It follows the installer's own
 * ending (each agent's ending in
 * backend/src/services/agent-connection-setup/agents/), which prints in full at
 * the end of the output.
 */
function scriptNextSteps(client: ConnectClient): string[] {
  switch (client.id) {
    case "claude-code":
      return [
        "Say yes when the terminal offers to sign you in to the gateway.",
        "Open a new terminal and run the claude command it prints. Skills load on their own.",
      ];
    case "cursor":
      return [
        "Reload Cursor.",
        "Open Customize > MCPs and sign in to the gateway.",
        'If the output shows "Cursor model settings", enter them under Settings > Models > API Keys.',
      ];
    case "codex":
      return [
        "Say yes when the terminal offers to sign you in to the gateway.",
        "Open a new terminal and run the codex command it prints.",
        "For skills, run /plugins in Codex and install the plugin.",
      ];
    case "copilot-cli":
      return [
        "If you connected an LLM provider, its settings are saved in providers.json. The printed environment variables are optional.",
        "Open a new terminal and run the copilot command it prints. It opens the browser to sign in to the gateway.",
      ];
    case "opencode":
      return [
        "Say yes when the terminal offers to sign you in to the gateway.",
        "Close OpenCode if it's open, then run the opencode command it prints in a new terminal.",
      ];
    default:
      return [`Restart ${nameOf(client)}.`];
  }
}

// === Connect band heading: the one instruction ===

function currentStep(client: ConnectClient, setup: SetupMode): string {
  const name = nameOf(client);
  switch (setup) {
    case "manual":
      return `Follow the steps for ${name}`;
    case "script":
      return "Run the command in your terminal";
    case "download":
      return `Download the installer for ${name}`;
    case "prompt":
      return `Paste the prompt into ${name}`;
  }
}

function Band({
  busy,
  dim,
  children,
}: {
  /** Settings are being re-read: hold actions until they land. */
  busy?: boolean;
  /** Connected: the next step is in the card below. */
  dim?: boolean;
  children: ReactNode;
}) {
  // Same accent as the heading's marker.
  return (
    <section
      aria-label="Connect"
      aria-busy={busy}
      inert={busy}
      className={cn(
        "relative rounded-3xl border border-primary/40 bg-card p-5 shadow-sm ring-1 ring-primary/15 transition-[color,background-color,border-color,opacity] duration-300",
        dim && "opacity-50",
      )}
    >
      {children}
    </section>
  );
}

function StepHeading({ step }: { step: string }) {
  return (
    <h2
      key={step}
      className="inline-flex items-center gap-2.5 text-sm font-semibold tracking-tight motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
    >
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground [&_svg]:size-3.5"
      >
        <ArrowDown strokeWidth={2.5} />
      </span>
      {step}
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
  const steps = useManualSteps(client, data);
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
            <h3 className="pt-1 text-sm font-semibold">{s.title}</h3>
            <div className="mt-3 min-w-0 max-w-5xl">{s.content}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

// === Guardrails status ===

/**
 * Agents OpenAPPA follows natively (the Claude Code, Codex and OpenCode
 * adapters in backend/src/proxy/plugins/appa-plugin-archestra/
 * session-identity.ts). Others count as unsupported unless they send OpenAPPA
 * session headers, which the agents on this page don't.
 */
const GUARDRAILS_NATIVE = new Set(["claude-code", "codex", "opencode"]);

/**
 * What the guardrails do for this agent, from the real deployment setting.
 * Guardrails sit on the LLM proxy, so they only see an agent whose model
 * requests go through it. null: the user can't read the setting.
 */
function guardrailsStatus(
  data: ConnectPageData,
  client: ConnectClient,
  routed: boolean,
): {
  tone?: "ok" | "warn" | "block";
  label: string;
  detail: string;
} | null {
  const { state } = data.guardrails;
  if (state === null) return null;
  // Three states: Enforced, Not enforced (requests bypass the guardrails and
  // run without checks) and Blocked.
  if (state === "off")
    return {
      tone: "warn",
      label: "Not enforced",
      detail: `Your admin hasn't turned on guardrails, so ${client.label}'s tool calls aren't checked against the policy.`,
    };
  if (!routed)
    return {
      tone: "warn",
      label: "Not enforced",
      detail:
        client.proxy.kind === "unsupported"
          ? `Guardrails work through the LLM proxy, and ${client.label} sends its model requests to its own service, so its tool calls aren't checked against the policy.`
          : `Guardrails work through the LLM proxy, and it's off for ${client.label}, so its tool calls aren't checked against the policy.`,
    };
  if (GUARDRAILS_NATIVE.has(client.id))
    return {
      tone: "ok",
      label: "Enforced",
      detail: `Each of ${client.label}'s tool calls is checked against your organization's policy.`,
    };
  return state === "block"
    ? {
        tone: "block",
        label: "Blocked",
        detail: `Guardrails don't recognize ${client.label}, and your org blocks unrecognized agents, so the LLM proxy rejects its model requests.`,
      }
    : {
        tone: "warn",
        label: "Not enforced",
        detail: `Guardrails don't recognize ${client.label}, and your org lets unrecognized agents through, so its tool calls aren't checked against the policy.`,
      };
}

// === Profile card ===

/** "See all 5 skills", or "See the skill" when there's one. */
function seeAllLabel(count: number, noun: string) {
  return count === 1
    ? `See the ${noun}`
    : `See all ${fmt(count)} ${plural(count, noun)}`;
}

// Up to this many entries per list; the See all row under them shows the rest.
const SERVER_ROWS = 4;
const SKILL_ROWS = 4;
const PLUGIN_ROWS = 4;

/** How the plugins land in this agent, after the setup. */
function pluginInstallNote(client: ConnectClient): string {
  switch (client.id) {
    case "codex":
      return "approve their hooks in /hooks after setup";
    case "cursor":
      return "you add them in Cursor after setup";
    default:
      return "installed with the setup";
  }
}

interface StatusItem {
  id: string;
  icon: ReactNode;
  label: string;
  /** The state in words, or the switch that sets it. */
  state: ReactNode;
  /** The info button after the state. */
  tip: ReactNode;
}

function ProfileCard({
  data,
  client,
  servers,
  tools,
  skills,
  skillsOff,
  plugins,
  pluginsOff,
  routed,
  choices,
  onOpen,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  /** This agent's model requests go through the LLM proxy. */
  routed: boolean;
  /** Every skill on offer; dimmed when the user leaves skills out. */
  skills: ConnectPageSkill[];
  skillsOff: boolean;
  /** Every plugin on offer for this agent; dimmed when left out. */
  plugins: ConnectPlugin[];
  pluginsOff: boolean;
  servers: ConnectServer[];
  tools: number | null;
  choices: ConnectChoices;
  /** Opens a dialog; for servers and skills, on one row's item. */
  onOpen: (d: DialogKind, item?: string) => void;
}) {
  // Servers and skills show whenever the org offers them, even empty, so
  // the card keeps its shape; then they say so in place of a list. Plugins
  // only show once this agent has one.
  const skillsOn = data.skillsEnabled;
  const pluginsOn = data.partsFor(client).plugins;
  const proxyOn = data.partsFor(client).proxy;

  // One line under the lists. A future capability is one more entry.
  const status: StatusItem[] = [];
  // The LLM proxy's real state for this agent: the admin setting, whether
  // the agent can use a custom model endpoint, then the user's choice.
  const proxyReason = !data.llmProxyEnabled
    ? `Your admin hasn't turned on ${data.appName}'s LLM proxy, so ${client.label} calls its model provider directly.`
    : client.proxy.kind === "unsupported"
      ? `${client.label} can't send its model requests to ${data.appName}'s LLM proxy, so it calls its model provider directly.`
      : !routed
        ? `You turned the LLM proxy off, so ${client.label} calls its model provider directly. Turn it back on in Choose what to include.`
        : `${client.label}'s model requests go through ${data.appName}'s LLM proxy. Same models, plus your org's limits, logging and cost tracking.`;
  status.push({
    id: "routing",
    icon: (
      <Cpu className={cn(routed && "text-emerald-600 dark:text-emerald-400")} />
    ),
    label: "LLM proxy",
    tip: (
      <InfoTip label="What the LLM proxy does">
        <TipBody reason={proxyReason} />
      </InfoTip>
    ),
    state: !data.llmProxyEnabled
      ? "Not active"
      : !proxyOn
        ? "Not supported"
        : choices.proxy
          ? "On"
          : "Off",
  });
  const guard = guardrailsStatus(data, client, routed);
  if (guard)
    status.push({
      id: "guardrails",
      icon:
        guard.tone === "ok" ? (
          <ShieldCheck className="text-emerald-600 dark:text-emerald-400" />
        ) : (
          <ShieldOff
            className={cn(
              guard.tone === "block"
                ? "text-destructive"
                : "text-amber-600 dark:text-amber-400",
            )}
          />
        ),
      label: "Guardrails",
      tip: (
        <InfoTip label="What the guardrails do">
          <TipBody reason={guard.detail} />
        </InfoTip>
      ),
      state: guard.label,
    });

  const included =
    (skillsOn && !skillsOff ? skills.length : 0) +
    (pluginsOff ? 0 : plugins.length);

  return (
    <aside
      aria-label={`What ${client.label} gets`}
      className="relative min-w-0 rounded-3xl border bg-card shadow-sm"
    >
      <StepPill>
        <span key={`icon-${client.id}`} className="connect-icon">
          <ClientIcon client={client} size={16} />
        </span>
        What {client.label} gets
      </StepPill>

      <div className="px-5 pt-6 pb-5">
        {/* One short line; the lists below speak for themselves. The card's
            one place to leave parts out sits across from it. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="text-sm leading-snug text-pretty text-foreground">
            {cardIntro(data, servers, included)}
          </p>
          {(data.gateways.length > 1 ||
            data.partsFor(client).skills ||
            pluginsOn ||
            proxyOn) && (
            <Button
              variant="ghost"
              size="xs"
              className="-mr-1.5 shrink-0 text-muted-foreground"
              onClick={() => onOpen("include")}
            >
              <SlidersHorizontal />
              Choose what to include
            </Button>
          )}
        </div>

        {/* Lists keep their height whatever is picked or left out: each
            holds its rows plus See all, and headers stay on one line, so the
            card doesn't jump between agents. */}
        <ul
          className={cn(
            "mt-3 grid gap-x-8 gap-y-5",
            skillsOn && pluginsOn
              ? "@min-[44rem]:grid-cols-3"
              : skillsOn || pluginsOn
                ? "@min-[36rem]:grid-cols-2"
                : "",
          )}
        >
          <li className="relative min-w-0">
            {data.servers.length === 0 && tools === 0 ? (
              <ListBlock
                icon={<Wrench />}
                title="MCP servers"
                sub="0 tools"
                muted
                empty="No tools are available to your account through this gateway."
              />
            ) : (
              <ListBlock
                icon={<Wrench />}
                title={`${fmt(servers.length)} MCP ${plural(servers.length, "server")}`}
                sub={
                  tools === null
                    ? data.toolPreviewError
                      ? "Tool counts unavailable"
                      : "Loading tool counts…"
                    : `${fmt(tools)} ${plural(tools, "tool")}${data.progressive ? " loaded, more on demand" : ""}`
                }
                // The context cost sits on the header, across from the count.
                aside={
                  tools !== null && tools > 0 && data.toolTokens ? (
                    <ToolLoadingNote
                      progressive={data.progressive}
                      clientId={client.id}
                      tools={tools}
                      tokens={data.toolTokens.total}
                      count={data.toolTokens.count}
                    />
                  ) : undefined
                }
                onTitle={() => onOpen("servers")}
                seeAll={seeAllLabel(servers.length, "MCP server")}
              >
                {servers.slice(0, SERVER_ROWS).map((s) => (
                  <ListRow
                    key={s.key}
                    onClick={() => onOpen("servers", s.key)}
                    title={`View ${s.name} tools`}
                  >
                    <McpCatalogIcon
                      icon={s.icon}
                      catalogId={s.catalogId ?? undefined}
                      size={15}
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {s.name}
                    </span>
                  </ListRow>
                ))}
              </ListBlock>
            )}
          </li>

          {skillsOn && skills.length === 0 && (
            <li className="relative min-w-0">
              <ListBlock
                icon={<BookOpen />}
                title="Skills"
                sub="none yet"
                muted
                empty="Your organization hasn't shared any skills yet. They show up here."
              />
            </li>
          )}
          {skillsOn && skills.length > 0 && (
            <li className="relative min-w-0">
              <ListBlock
                icon={<BookOpen />}
                title={
                  skillsOff
                    ? "Skills off"
                    : `+${fmt(skills.length)} ${plural(skills.length, "skill")}`
                }
                sub={
                  skillsOff
                    ? "turn them on in Choose what to include"
                    : "loaded when a task needs one"
                }
                muted={skillsOff}
                onTitle={() => onOpen("skills")}
                seeAll={seeAllLabel(skills.length, "skill")}
              >
                {skills.slice(0, SKILL_ROWS).map((s) => (
                  <ListRow
                    key={s.id}
                    onClick={() => onOpen("skills", s.id)}
                    title={s.description}
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {s.name}
                    </span>
                  </ListRow>
                ))}
              </ListBlock>
            </li>
          )}

          {pluginsOn && (
            <li className="relative min-w-0">
              <ListBlock
                icon={<Puzzle />}
                title={
                  pluginsOff
                    ? "Plugins off"
                    : `+${fmt(plugins.length)} ${plural(plugins.length, "plugin")}`
                }
                sub={
                  pluginsOff
                    ? "turn them on in Choose what to include"
                    : pluginInstallNote(client)
                }
                muted={pluginsOff}
                onTitle={() => onOpen("plugins")}
                seeAll={seeAllLabel(plugins.length, "plugin")}
              >
                {plugins.slice(0, PLUGIN_ROWS).map((p) => (
                  <ListRow
                    key={p.id}
                    onClick={() => onOpen("plugins")}
                    title={p.description ?? p.name}
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {p.name}
                    </span>
                  </ListRow>
                ))}
              </ListBlock>
            </li>
          )}
        </ul>
      </div>

      {/* One line along the bottom: how the agent's requests are handled.
          The items meet on the card's center, under the line down to the
          connect card. */}
      {status.length > 0 && (
        <div className="grid grid-cols-2 items-center gap-x-8 rounded-b-3xl border-t bg-muted/30 px-5 py-2 text-xs">
          {status.map((c, i) => (
            <div
              key={c.id}
              data-status-chip
              className={cn(
                "flex min-w-0 items-center gap-1.5 [&>svg]:size-3.5 [&>svg]:shrink-0",
                i === 0 ? "justify-self-end" : "justify-self-start",
                // A lone item sits on the center.
                status.length === 1 && "col-span-2 justify-self-center",
              )}
            >
              {c.icon}
              <span className="font-semibold">{c.label}</span>
              <span aria-hidden className="text-muted-foreground/60">
                ·
              </span>
              <span className="inline-flex items-center text-muted-foreground">
                {c.state}
              </span>
              {c.tip}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function ListBlock({
  icon,
  title,
  sub,
  muted,
  onTitle,
  aside,
  seeAll,
  empty,
  children,
}: {
  icon: ReactNode;
  title: string;
  sub: ReactNode;
  muted?: boolean;
  /** The title opens the full list. */
  onTitle?: () => void;
  /** The title line's right side, e.g. context cost. */
  aside?: ReactNode;
  /** A last row, styled apart, that opens the full list. */
  seeAll?: string;
  /** Nothing to list yet: this line, in the list's place and room. */
  empty?: string;
  children?: ReactNode;
}) {
  const titleClass = cn(
    "truncate text-sm font-semibold tracking-tight tabular-nums",
    muted && "text-muted-foreground",
  );
  return (
    <div>
      <div className="flex min-w-0 items-center gap-2.5">
        <ChipIcon>{icon}</ChipIcon>
        <span className="flex min-w-0 flex-1 flex-col items-start">
          {/* The aside shares only the title's line, so the subtitle keeps
              the full width; in a narrow column it wraps under the title,
              still on the right. Only the title opens the list. */}
          <span className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-2">
            {onTitle ? (
              <UnstyledButton
                type="button"
                onClick={onTitle}
                className={cn(
                  titleClass,
                  "min-w-0 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                )}
              >
                {title}
              </UnstyledButton>
            ) : (
              <span className={titleClass}>{title}</span>
            )}
            {aside && (
              <span className="ml-auto shrink-0 text-xs whitespace-nowrap">
                {aside}
              </span>
            )}
          </span>
          <span
            title={typeof sub === "string" ? sub : undefined}
            className={cn(
              "max-w-full truncate text-xs text-muted-foreground",
              // A longer line wraps rather than hide what it says.
              typeof sub !== "string" &&
                "flex min-w-0 flex-wrap items-center gap-x-2.5 whitespace-normal",
            )}
          >
            {sub}
          </span>
        </span>
      </div>
      {(children || seeAll || empty) && (
        // Room for every row plus See all, filled or not.
        <div
          className={cn(
            "mt-2 min-h-[8.375rem] border-t pt-1 pl-1 text-xs transition-opacity",
            muted && !empty && "opacity-50",
          )}
        >
          {empty && (
            <p className="py-1 pr-2 leading-relaxed text-muted-foreground">
              {empty}
            </p>
          )}
          {children}
          {seeAll && onTitle && (
            <TextButton
              onClick={onTitle}
              className="mt-0.5 inline-flex h-6.5 items-center text-muted-foreground"
            >
              {seeAll}
            </TextButton>
          )}
        </div>
      )}
    </div>
  );
}

function ListRow({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <UnstyledButton
      type="button"
      onClick={onClick}
      title={title}
      className="group/row -mx-1.5 flex h-6.5 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover/row:text-foreground motion-safe:group-hover/row:translate-x-0.5" />
    </UnstyledButton>
  );
}

/** What the included tools cost in context, beside the servers' header. */
function ToolLoadingNote({
  clientId,
  progressive,
  tools,
  tokens,
  count,
}: {
  clientId: string;
  progressive: boolean;
  tools: number;
  /** Observed or estimated tokens of the tool list the agent starts with. */
  tokens: number | null;
  count: NonNullable<ConnectPageData["toolTokens"]>["count"];
}) {
  // The rounded count stays compact; the tooltip identifies its source.
  const label =
    tokens !== null
      ? approxTokens(tokens)
      : progressive
        ? "Tools load on demand"
        : `All ${fmt(tools)} ${plural(tools, "tool")} load when a session starts`;
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Gauge className="size-3.5 shrink-0" />
      {label}
      <InfoTip label="How tools load">
        {progressive
          ? `Your agent starts with ${fmt(tools)} ${plural(tools, "tool")} and finds more when a task needs them.`
          : `All ${fmt(tools)} ${plural(tools, "tool")} load at the start of each session. More tools take more of your agent's working memory.`}
        <span hidden={tokens === null}>
          {" "}
          {count?.source === "claude-provider"
            ? `Last matching provider count for ${count.model}, observed ${new Date(count.observedAt).toLocaleString()}. Other connections and tools loaded during your session can change the count.`
            : clientId === "claude-code"
              ? "Uses Claude Code's local fallback estimate until a matching provider count passes through the LLM proxy. Its model, tool search settings, and other connections can change the count."
              : "Estimated from this gateway's tool definitions. Your agent's formatting, model, and other connections can change the count."}
        </span>
      </InfoTip>
    </span>
  );
}

/** The gateway the admin picked, then the lists; empty states in words. */
function cardIntro(
  data: ConnectPageData,
  servers: ConnectServer[],
  /** Skills and plugins included. */
  extras: number,
): ReactNode {
  if (servers.length > 0 || extras > 0)
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

/** A status tooltip explaining why this state applies. */
function TipBody({ reason }: { reason: string }) {
  return <span className="block">{reason}</span>;
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

function ChipIcon({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "block";
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border [&_svg]:size-4",
        tone === "ok"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : tone === "warn"
            ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            : tone === "block"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

// === Loading ===

function LoadingState() {
  return (
    <div className="mx-auto w-full max-w-7xl px-6 pt-18 md:px-10 lg:px-14">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-12 w-[36rem] max-w-full" />
        <Skeleton className="h-5 w-[30rem] max-w-full" />
      </div>
      <Skeleton className="mt-14 h-24 rounded-xl" />
      <Skeleton className="mt-9 h-56 rounded-3xl" />
      <Skeleton className="mt-9 h-36 rounded-3xl" />
    </div>
  );
}
