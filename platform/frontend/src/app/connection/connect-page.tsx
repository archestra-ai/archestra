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
  Download,
  Gauge,
  Info,
  ListOrdered,
  MessageSquareText,
  MoreHorizontal,
  Settings,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import { BaseUrlSelect } from "./base-url-select";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";
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
  BrowseDialog,
  fmt,
  InfoDialog,
  nameOf,
  plural,
} from "./connect-page-parts";
import { type SetupMode, setupModeFor, useManualSteps } from "./manual-setup";
import { detectPlatform } from "./platform.utils";
import { useUpdateUrlParams } from "./use-update-url-params";

// The approval panel is large; the page only needs it for Claude Desktop's
// installer download, so it loads on demand.
const ConnectCommandPanel = dynamic(
  () => import("./connect-command-panel").then((m) => m.ConnectCommandPanel),
  { ssr: false },
);

type DialogKind = "servers" | "skills" | "plugins" | "cursor";

const MOTION_CSS = `
@keyframes connect-pop {
  0% { opacity: 0; transform: translateY(16px) scale(0.92); }
  55% { opacity: 1; transform: translateY(-5px) scale(1.025); }
  78% { transform: translateY(1.5px) scale(0.995); }
  100% { opacity: 1; transform: none; }
}
@keyframes connect-icon {
  0% { opacity: 0.3; transform: scale(0.78) rotate(-8deg); }
  60% { opacity: 1; transform: scale(1.07) rotate(2deg); }
  100% { opacity: 1; transform: none; }
}
.connect-chip { animation: connect-pop 0.62s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.connect-icon { animation: connect-icon 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
@media (prefers-reduced-motion: reduce) {
  .connect-chip, .connect-icon { animation: none; }
}
`;

export function ConnectPage() {
  usePageTitle("Connect");
  const data = useConnectPageData();
  // Links (connect.md, docs) can open the page on an app, and on its manual
  // setup with ?mode=manual. Picks and the Manual toggle are written back.
  const searchParams = useSearchParams();
  const updateUrlParams = useUpdateUrlParams();
  const [pickedId, setPickedId] = useState(() => searchParams.get("clientId"));
  // null until the user toggles: then ?mode=manual decides, for the app the
  // page actually lands on.
  const [manualChosen, setManualChosen] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  // What the user leaves out, per agent. The prompt carries it, and this
  // browser keeps it for a while (connect-choices.ts).
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
  const routingOptional = client ? canChooseRouting(data, client) : false;
  useEffect(() => {
    // Tools and plugins are always included. Skills can be left out, and
    // model routing too for apps with an installer (Choose what to include).
    if (!clientId) return;
    const saved = readConnectChoices(clientId);
    setChoices({
      ...saved,
      tools: true,
      proxy: routingOptional ? saved.proxy : true,
      plugins: true,
    });
  }, [clientId, routingOptional]);

  if (data.loading || !client) return <LoadingState />;

  const parts = data.partsFor(client);
  const routed = parts.proxy && choices.proxy;
  const servers = choices.tools ? data.servers : [];
  const tools = servers.reduce((n, s) => n + s.toolCount, 0);
  const skillsOn = data.skillsEnabled && data.totalSkills > 0;
  const skills = skillsOn && choices.skills ? skillsSorted : [];
  const skillCount = skills.length;
  const prompt = data.connectPrompt(client, choices);
  const setChoice = (part: keyof ConnectChoices, value: boolean) => {
    const next = { ...choices, [part]: value };
    setChoices(next);
    saveConnectChoices(client.id, next);
  };

  const setup = setupModeFor(client);
  const manualOn =
    manualChosen ??
    (searchParams.get("mode") === "manual" && setup === "prompt-or-manual");
  const manual =
    setup === "manual" || (setup === "prompt-or-manual" && manualOn);
  // Apps with an installer can also run it straight from a terminal. Claude
  // Desktop keeps its own download flow.
  const scriptable = setup === "prompt" && client.id !== "claude-desktop";
  const script = scriptable && manualOn;
  // Claude Desktop installs from a downloaded installer by default; its
  // Prompt (for Cowork) is the alternative, so the toggle reads inverted.
  const download = client.id === "claude-desktop" && !manualOn;
  const step = currentStep(client, manual, script, download);

  const pick = (id: string) => {
    setPickedId(id);
    setManualChosen(false);
    // Manual steps bookmark a provider; providers vary per app.
    updateUrlParams({ clientId: id, mode: null, providerId: null });
  };

  return (
    <div className="relative w-full overflow-hidden text-foreground">
      <style>{MOTION_CSS}</style>
      <DotField />

      <div className="relative mx-auto w-full max-w-7xl px-6 pt-10 pb-16 md:px-10 lg:px-14 lg:pt-12">
        {data.canManage && (
          <div className="absolute top-4 right-6 md:right-10 lg:right-14">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="shadow-xs dark:bg-background"
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
            <p className="mt-4 max-w-[34rem] text-sm leading-relaxed text-muted-foreground">
              The MCP servers and skills your organization runs for itself, now
              usable in your agent of choice.
            </p>

            <h2 className="mt-6 text-sm font-semibold">
              {tileCount(data) === 1 ? "Your agent" : "Pick your agent"}
            </h2>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Your organization's tools and skills get added to the agent you
              pick.
            </p>
            <AgentTiles data={data} selected={client} onPick={pick} />
          </div>

          {/* Right: the agent's profile card */}
          <ProfileCard
            data={data}
            client={client}
            servers={servers}
            tools={tools}
            skills={skills}
            skillCount={skillCount}
            skillsOff={parts.skills && !choices.skills}
            routed={routed}
            choices={choices}
            onChoice={setChoice}
            onOpen={(d, item) => {
              setFocus(item ?? null);
              setDialog(d);
            }}
          />
        </section>

        {/* Full width under the hero: the prompt, or the manual steps. */}
        <ConnectArea
          data={data}
          client={client}
          setup={setup}
          step={step}
          manual={manual}
          scriptable={scriptable}
          script={script}
          download={download}
          choices={choices}
          prompt={prompt}
          onManual={(v) => {
            setManualChosen(v);
            // Only manual setup is bookmarkable; Script is a view of Prompt.
            if (setup === "prompt-or-manual")
              updateUrlParams({ mode: v ? "manual" : null });
          }}
          onCursorNote={() => setDialog("cursor")}
          footprint={data.footprintFor(client)}
          skillCount={skillCount}
        />
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
    </div>
  );
}

// === Background ===

function DotField() {
  // Fades out down the page, and clears behind the headline and picker so
  // the dots never sit under text.
  const mask = [
    "radial-gradient(ellipse 55% 65% at 28% 38%, transparent 35%, black 80%)",
    "linear-gradient(to bottom, black 0%, black 45%, transparent 100%)",
  ].join(", ");
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[760px] opacity-50 dark:opacity-70"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--border) 1.1px, transparent 1.4px)",
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
  onPick,
}: {
  data: ConnectPageData;
  selected: ConnectClient;
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
          onClick={() => onPick(c.id)}
          icon={<ClientIcon client={c} size={iconSize} />}
          label={c.label}
        />
      ))}
      {showOther && (
        <AgentSearch data={data} selectedId={selected.id} onPick={onPick}>
          <Tile
            roomy={row}
            active={!!otherPicked}
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

function Tile({
  roomy,
  active,
  icon,
  label,
  sub,
  onClick,
  ...rest
}: {
  active: boolean;
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
        "relative flex min-w-0 flex-col items-center gap-2 rounded-xl border bg-card px-2 text-xs transition-[border-color,background-color,color] duration-200 hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        roomy ? "pt-4 pb-3" : "pt-3 pb-2.5",
        active
          ? // The muted tint is layered over the card fill, so the page's
            // dots never show through a selected tile.
            "border-primary bg-linear-to-b from-muted/40 to-muted/40 font-semibold text-foreground ring-1 ring-primary"
          : "text-muted-foreground hover:bg-linear-to-b hover:from-muted/50 hover:to-muted/50 hover:text-foreground",
      )}
    >
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

// === Connect area: prompt, or the manual steps in its place ===

function ConnectArea({
  data,
  client,
  setup,
  step,
  manual,
  scriptable,
  script,
  download,
  choices,
  prompt,
  onManual,
  onCursorNote,
  footprint,
  skillCount,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  setup: SetupMode;
  step: string;
  manual: boolean;
  /** The app has an installer, so it offers Prompt / Script. */
  scriptable: boolean;
  /** Script is chosen: show the installer command instead of the prompt. */
  script: boolean;
  /** Claude Desktop's installer download replaces the prompt. */
  download: boolean;
  choices: ConnectChoices;
  /** null when every part is left out. */
  prompt: string | null;
  onManual: (v: boolean) => void;
  onCursorNote: () => void;
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
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy. Select the prompt and copy it manually.");
    }
  };
  // Other agents read the generic prompt, with or without a manual option.
  const generic = setup === "prompt-or-manual" || setup === "generic-prompt";
  const leftOutParts = (
    Object.keys(choices) as (keyof ConnectChoices)[]
  ).filter((part) => !choices[part]);

  return (
    <Band busy={data.revalidating}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <StepHeading step={step} />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Other agents read the endpoint from the prompt (or the manual
            steps), so its picker sits with them; apps with an installer pick
            it on the approval page. */}
          {generic && data.baseUrls.length > 1 && (
            <BaseUrlSelect
              size="sm"
              className="w-auto max-w-80"
              candidateUrls={data.baseUrls}
              metadata={data.baseUrlMetadata}
              value={data.baseUrl}
              onChange={data.selectBaseUrl}
            />
          )}
          {setup === "prompt-or-manual" && (
            <ModeSwitch
              alt={manual}
              altIcon={<ListOrdered />}
              altLabel="Manual setup"
              onChange={onManual}
            />
          )}
          {client.id === "claude-desktop" && (
            <ModeSwitch
              alt={download}
              altIcon={<Download />}
              altLabel="Download"
              onChange={(v) => onManual(!v)}
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
        </div>
      </div>

      {download ? (
        <>
          <ConnectCommandPanel
            // Remount on a changed selection; the panel reads it once.
            key={leftOutParts.join(",")}
            variant="download"
            client={client}
            exclude={leftOutParts}
            mcpGateways={data.gateway ? [data.gateway] : null}
            mcpGatewayId={data.gateway?.id ?? null}
            onMcpGatewaySelect={() => {}}
            llmProxyId={data.llmProxyId}
            shownProviders={data.shownProviders}
            urlProvider={null}
            onProviderSelect={() => {}}
            baseUrl={data.baseUrl}
            candidateBaseUrls={data.baseUrls}
            baseUrlMetadata={data.baseUrlMetadata}
            onBaseUrlChange={data.selectBaseUrl}
            skillsEnabled={data.skillsEnabled}
            pluginsEnabled={data.pluginsEnabled}
          />
          <BandFooter>
            <span>{footprintSummary(client, footprint, skillCount)}</span>
          </BandFooter>
        </>
      ) : manual ? (
        // The steps take the prompt's place, starting right here.
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
            {script ? (
              <p>
                Run it in a terminal on the computer where you use{" "}
                {nameOf(client)}. It needs Node.js 18 or newer, opens a browser
                page, and changes nothing until you approve.
              </p>
            ) : (
              <p>
                {nameOf(client) === "your agent"
                  ? "Your agent"
                  : nameOf(client)}{" "}
                {generic
                  ? "checks what it supports and asks before changing anything."
                  : "opens a browser page. Nothing changes until you approve."}
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
              className="h-12 shrink-0 rounded-xl px-6"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : script ? "Copy command" : "Copy prompt"}
            </Button>
          </div>

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

          {/* Footer: what connecting adds. */}
          <BandFooter>
            <span>{footprintSummary(client, footprint, skillCount)}</span>
          </BandFooter>
        </>
      )}
    </Band>
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
 * The Script option's "When it finishes" list. Its meaning follows the setup
 * script's own Next steps (nextStepsFor in
 * backend/src/services/connection-setup-script.ts); the full list prints at
 * the end of the output.
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

function currentStep(
  client: ConnectClient,
  manual: boolean,
  script: boolean,
  download: boolean,
): string {
  const name = nameOf(client);
  if (manual) return `Follow the steps for ${name}`;
  if (script) return "Run the command in your terminal";
  if (download) return `Download the installer for ${name}`;
  return `Paste the prompt into ${name}`;
}

function Band({
  busy,
  children,
}: {
  /** Settings are being re-read: hold actions until they land. */
  busy?: boolean;
  children: ReactNode;
}) {
  // Same accent as the heading's marker.
  return (
    <section
      aria-label="Connect"
      aria-busy={busy}
      inert={busy}
      className="mt-6 rounded-3xl border border-primary/40 bg-card/80 p-5 shadow-sm ring-1 ring-primary/15 transition-colors duration-300 md:px-7 md:py-6"
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
          ? "bg-background font-semibold text-foreground shadow-sm"
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
  if (state === "off")
    return {
      label: "Off",
      detail:
        "Your admin hasn't turned the guardrails on, so nothing is checked yet.",
    };
  if (!routed)
    return {
      label: "Not applied",
      detail: `Guardrails check model requests that go through ${data.appName}. With model routing off, ${client.label}'s requests aren't checked.`,
    };
  if (GUARDRAILS_NATIVE.has(client.id))
    return {
      tone: "ok",
      label: "Active",
      detail: `${client.label} is supported, so its requests are checked.`,
    };
  return state === "block"
    ? {
        tone: "block",
        label: "Blocks this agent",
        detail: `${client.label} isn't supported by the guardrails yet, and your org blocks unsupported agents, so its model requests will be rejected.`,
      }
    : {
        tone: "warn",
        label: "Passes through unchecked",
        detail: `${client.label} isn't supported by the guardrails yet. Your org lets unsupported agents through, so its requests run without checks.`,
      };
}

// === Profile card ===

/**
 * Only apps with an installer are known to take model routing, so only they
 * show it and let the user leave it out; other agents work it out from the
 * prompt, so the card makes no promise.
 */
function canChooseRouting(data: ConnectPageData, client: ConnectClient) {
  return data.partsFor(client).proxy && setupModeFor(client) === "prompt";
}

/** The card's one place to leave parts out; the prompt carries the result. */
function IncludeMenu({
  skills,
  routing,
  choices,
  onChoice,
}: {
  skills: boolean;
  routing: boolean;
  choices: ConnectChoices;
  onChoice: (part: keyof ConnectChoices, value: boolean) => void;
}) {
  const rows: {
    id: string;
    title: string;
    sub: string;
    part?: keyof ConnectChoices;
  }[] = [
    { id: "tools", title: "Tools", sub: "Always included" },
    ...(skills
      ? [
          {
            id: "skills",
            title: "Skills",
            sub: "Loaded when a task needs one",
            part: "skills" as const,
          },
        ]
      : []),
    ...(routing
      ? [
          {
            id: "proxy",
            title: "Model routing",
            sub: "Model requests go through the LLM proxy",
            part: "proxy" as const,
          },
        ]
      : []),
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-2 shrink-0 text-muted-foreground"
        >
          <SlidersHorizontal />
          Choose what to include
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-3 rounded-md px-2.5 py-2"
          >
            <label
              htmlFor={`include-${r.id}`}
              className={cn("min-w-0 flex-1", r.part && "cursor-pointer")}
            >
              <span className="block text-sm font-semibold">{r.title}</span>
              <span className="block text-xs text-muted-foreground">
                {r.sub}
              </span>
            </label>
            <Switch
              id={`include-${r.id}`}
              checked={r.part ? choices[r.part] : true}
              disabled={!r.part}
              onCheckedChange={(v) => r.part && onChoice(r.part, v)}
            />
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const SERVER_ROWS = 6;
const SKILL_ROWS = 6;

interface StatusChip {
  id: string;
  icon: ReactNode;
  title: ReactNode;
  sub: ReactNode;
}

function ProfileCard({
  data,
  client,
  servers,
  tools,
  skills,
  skillCount,
  skillsOff,
  routed,
  choices,
  onChoice,
  onOpen,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  /** This agent's model requests go through the LLM proxy. */
  routed: boolean;
  /** The user turned skills off (Choose what to include). */
  skillsOff: boolean;
  choices: ConnectChoices;
  onChoice: (part: keyof ConnectChoices, value: boolean) => void;
  servers: ConnectServer[];
  tools: number;
  skills: ConnectPageSkill[];
  skillCount: number;
  /** Opens a dialog; for servers and skills, on one row's item. */
  onOpen: (d: DialogKind, item?: string) => void;
}) {
  const gatewayName = data.gateway?.name;
  const skillsOn = data.skillsEnabled && data.totalSkills > 0;

  // Small status chips under the lists. A future capability is one entry.
  const statusChips: StatusChip[] = [];
  // Only apps with an installer are known to take model routing; other
  // agents work it out from the prompt, so the card makes no promise.
  const routingOptional = canChooseRouting(data, client);
  // Shown for every agent while the LLM proxy is on: apps with an installer
  // take it (unless left out); others get it ready through the prompt.
  if (data.partsFor(client).proxy)
    statusChips.push({
      id: "routing",
      icon: (
        <ChipIcon tone={routed ? "ok" : undefined}>
          <Cpu />
        </ChipIcon>
      ),
      title: (
        <span className="inline-flex items-center gap-1">
          Model routing
          <InfoTip label="What model routing does">
            {routingOptional
              ? `${client.label} sends model requests through ${data.appName}'s LLM proxy instead of straight to the provider.`
              : `${data.appName}'s LLM proxy is ready for ${client.label}'s model requests, if it lets you set a custom endpoint.`}{" "}
            Same models; your org's limits, logging and cost tracking apply.
          </InfoTip>
        </span>
      ),
      sub: !routed
        ? "Off"
        : routingOptional
          ? "On, through the LLM proxy"
          : "LLM proxy ready to use",
    });
  const guard = guardrailsStatus(data, client, routed);
  if (guard)
    statusChips.push({
      id: "guardrails",
      icon: (
        <ChipIcon tone={guard.tone}>
          {guard.tone === "ok" ? <ShieldCheck /> : <ShieldOff />}
        </ChipIcon>
      ),
      title: (
        <span className="inline-flex items-center gap-1">
          Guardrails
          <InfoTip label="What the guardrails do">
            Before a risky tool call runs (deleting data, sending messages
            outside the org), the guardrails check it against your org's rules
            and can ask you to approve it first. Powered by{" "}
            {data.guardrails.name}. {guard.detail}
          </InfoTip>
        </span>
      ),
      sub: (
        <span
          className={cn(
            guard.tone === "ok" && "text-emerald-600 dark:text-emerald-400",
            guard.tone === "warn" && "text-amber-600 dark:text-amber-400",
            guard.tone === "block" && "text-destructive",
          )}
        >
          {guard.label}
        </span>
      ),
    });

  return (
    <aside
      aria-label={`What ${client.label} gets`}
      className="relative min-w-0 rounded-3xl border bg-card p-5 shadow-sm lg:mt-2"
    >
      <div className="flex items-center gap-3.5">
        <div key={`icon-${client.id}`} className="connect-icon">
          <ClientIcon client={client} size={44} />
        </div>
        <div className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
          {client.label}
        </div>
        {(skillsOn || routingOptional) && (
          <IncludeMenu
            skills={skillsOn}
            routing={routingOptional}
            choices={choices}
            onChoice={onChoice}
          />
        )}
      </div>

      {/* One short line; the lists below speak for themselves. */}
      <p className="mt-4 text-sm leading-snug text-pretty text-foreground">
        {cardIntro(data, servers, skillsOn ? skillCount : 0)}
      </p>

      {/* Capability blocks: they stack in once on page load and stay put when
          another agent is picked (only the header animates per pick). */}
      <div className="mt-2.5">
        <ul className="flex flex-col gap-3">
          <li
            className="connect-chip relative"
            style={{ animationDelay: "140ms" }}
          >
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
                title={`+${fmt(tools)} ${plural(tools, "tool")}`}
                sub={
                  <>
                    from {fmt(servers.length)} MCP{" "}
                    {plural(servers.length, "server")}
                    <InfoTip label="What MCP servers are">
                      Tools your agent calls, served through your organization's
                      gateway{gatewayName ? ` (${gatewayName})` : ""}.
                    </InfoTip>
                  </>
                }
                more={
                  servers.length > SERVER_ROWS
                    ? `See all ${fmt(servers.length)}`
                    : "See all"
                }
                onMore={() => onOpen("servers")}
                footer={
                  tools > 0 && (
                    <ToolLoadingNote
                      progressive={data.progressive}
                      tools={tools}
                    />
                  )
                }
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
                        <span className="min-w-0 flex-1 truncate text-foreground">
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
              className="connect-chip relative"
              style={{ animationDelay: "250ms" }}
            >
              <ListBlock
                icon={<BookOpen />}
                title={
                  skillsOff
                    ? "Skills off"
                    : `+${fmt(skillCount)} ${plural(skillCount, "skill")}`
                }
                sub={
                  skillsOff
                    ? "turn them on in Choose what to include"
                    : "loaded when a task needs one"
                }
                muted={skillsOff}
                more={
                  !skillsOff && skillCount > SKILL_ROWS
                    ? `See all ${fmt(skillCount)}`
                    : "See all"
                }
                onMore={() => onOpen("skills")}
              >
                {skillsOff ? null : skills.length === 0 ? (
                  <span className="block py-1 text-muted-foreground">
                    No skills yet.
                  </span>
                ) : (
                  <span className="grid grid-cols-2 gap-x-2">
                    {skills.slice(0, SKILL_ROWS).map((s) => (
                      <UnstyledButton
                        key={s.id}
                        type="button"
                        onClick={() => onOpen("skills", s.id)}
                        title={s.description}
                        className="-mx-1.5 flex h-6.5 min-w-0 items-center rounded-md px-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <span className="min-w-0 truncate text-foreground">
                          {s.name}
                        </span>
                      </UnstyledButton>
                    ))}
                  </span>
                )}
              </ListBlock>
            </li>
          )}

          {statusChips.length > 0 && (
            <li
              className="connect-chip relative"
              style={{ animationDelay: "360ms" }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {statusChips.map((c) => {
                  const body = (
                    <>
                      {c.icon}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold tracking-tight">
                          {c.title}
                        </span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          {c.sub}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <div
                      key={c.id}
                      className="flex min-w-0 items-center gap-2.5 rounded-xl border bg-background py-2 pr-3 pl-2 text-left"
                    >
                      {body}
                    </div>
                  );
                })}
              </div>
            </li>
          )}
        </ul>
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
  footer,
  children,
}: {
  icon: ReactNode;
  title: string;
  sub: ReactNode;
  muted?: boolean;
  more?: string;
  onMore?: () => void;
  /** A tinted strip across the bottom of the block. */
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="py-2 pr-3.5 pl-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ChipIcon>{icon}</ChipIcon>
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                "text-sm font-semibold tracking-tight tabular-nums",
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
      {footer && <div className="border-t px-3 py-1.5 text-xs">{footer}</div>}
    </div>
  );
}

/** How the included tools reach the agent, as the tools block's footer. */
function ToolLoadingNote({
  progressive,
  tools,
}: {
  progressive: boolean;
  tools: number;
}) {
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground">
      <Gauge className="size-3.5 shrink-0" />
      {progressive
        ? "Tools load on demand"
        : `All ${fmt(tools)} ${plural(tools, "tool")} load when a session starts`}
      <InfoTip label="How tools load">
        {progressive
          ? "Your agent starts with a small fixed set of tools and finds the rest when a task needs them. Adding servers doesn't grow it."
          : "Every included tool loads at the start of each session. More tools take more of your agent's working memory."}
      </InfoTip>
    </p>
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
