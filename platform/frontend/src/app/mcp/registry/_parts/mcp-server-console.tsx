"use client";

// The Logs / Inspector / Shell console of a local MCP server's detail page:
// one dark frame whose top bar carries the connection switcher, its state and
// the tab's own actions, and whose tmux-style status bar carries the tab's live
// status and the equivalent kubectl command. Only the body swaps between tabs.

import { E2eTestId, type McpDeploymentStatusEntry } from "@archestra/shared";
import {
  Building2,
  Check,
  ChevronsUpDown,
  Copy,
  Info,
  Loader2,
  RefreshCw,
  SquareTerminal,
  TextSelect,
  User,
  Users,
  WrapText,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils/tailwind";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { hasNoPodToStream } from "./logs-streaming-indicator";
// SPDX-SnippetEnd
import type { McpLogsInstall } from "./mcp-logs-dialog";
import {
  InspectorBody,
  InspectorStatus,
  useInspector,
} from "./mcp-server-console-inspector";
import { LogsBody, LogsStatus, useLogStream } from "./mcp-server-console-logs";
import {
  ShellBody,
  ShellStatus,
  useShellSession,
} from "./mcp-server-console-shell";
import {
  BarButton,
  BarToggle,
  CommandChip,
  ConnDot,
  type ConnState,
  ConsoleState,
  connState,
  connStateLabel,
  copyText,
  Pulse,
  SegButton,
  StatusItem,
} from "./mcp-server-console-ui";

export type McpServerConsoleTab = "logs" | "inspector" | "debug";

export function McpServerConsole({
  tab,
  serverName,
  installs,
  deploymentStatuses,
  initialServerId,
}: {
  /** Which page tab is showing; tab switching lives in the page's tab strip. */
  tab: McpServerConsoleTab;
  serverName: string;
  installs: McpLogsInstall[];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  initialServerId: string | null;
}) {
  const [serverId, setServerId] = useState<string | null>(null);

  // The Inspector connects to the upstream as the selected install, signed
  // with that install's stored credential — so it only offers connections the
  // viewer may actually use. Logs and Shell read the pod rather than
  // authenticate as it, and keep the full list an installation admin needs.
  const selectableInstalls = useMemo(
    () =>
      tab === "inspector"
        ? installs.filter((i) => i.canUseCredential !== false)
        : installs,
    [tab, installs],
  );

  useEffect(() => {
    if (selectableInstalls.length === 0) return;
    if (serverId && selectableInstalls.some((i) => i.id === serverId)) return;
    const initial =
      initialServerId &&
      selectableInstalls.some((i) => i.id === initialServerId)
        ? initialServerId
        : selectableInstalls[0].id;
    setServerId(initial);
  }, [selectableInstalls, serverId, initialServerId]);

  const { data: session } = useSession();
  const myEmail = session?.user?.email ?? null;

  // Switching to the Inspector while someone else's connection is selected
  // leaves the stale id until the effect above re-defaults; inspect nothing
  // against it in the meantime.
  const inspectorServerId =
    serverId && selectableInstalls.some((i) => i.id === serverId)
      ? serverId
      : null;
  const status = serverId ? deploymentStatuses[serverId] : undefined;
  const isRunning = status?.state === "running";

  // A shell runs commands inside the server's container in the cluster, so it
  // stays with the people who manage installations; the backend refuses it to
  // everyone else too.
  const { data: canOpenShell } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // No pod (never deployed, or idle-hibernated): nothing to tail, so don't
  // open a stream that can only time out.
  const noPod = hasNoPodToStream(status);
  // SPDX-SnippetEnd
  const logs = useLogStream(noPod ? null : serverId);
  const inspector = useInspector(
    inspectorServerId,
    tab === "inspector" && isRunning,
  );
  const shellActive =
    tab === "debug" && !!serverId && !!canOpenShell && isRunning;
  const shell = useShellSession(serverId, shellActive);

  let actions: ReactNode = null;
  let statusLeft: ReactNode = null;
  let statusRight: ReactNode = null;
  let body: ReactNode = null;
  const podName = status?.podName ? (
    <span className="truncate text-slate-500">{status.podName}</span>
  ) : null;

  if (tab === "logs") {
    actions = (
      <>
        <BarToggle
          pressed={logs.wrap}
          onClick={() => logs.setWrap(!logs.wrap)}
          icon={<WrapText />}
          label="Wrap"
        />
        <BarButton
          icon={<Copy />}
          label="Copy"
          disabled={!logs.content}
          onClick={() => copyText(logs.content, "Logs copied to clipboard")}
        />
      </>
    );
    statusLeft = <LogsStatus logs={logs} status={status} />;
    statusRight = logs.command ? (
      <CommandChip command={logs.command} />
    ) : (
      podName
    );
    body = <LogsBody logs={logs} status={status} noPod={noPod} />;
  } else if (tab === "inspector") {
    if (inspectorServerId && isRunning) {
      actions = (
        <>
          <BarButton
            icon={<Zap />}
            label="List tools"
            disabled={inspector.isLoading}
            onClick={inspector.loadTools}
          />
          <BarButton
            icon={
              inspector.isReloading ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )
            }
            label="Refresh tools"
            title="Re-sync the registry's tool catalog from the live server so agents and gateway clients see the current tools"
            disabled={inspector.isReloading}
            onClick={inspector.reloadCatalog}
          />
        </>
      );
    }
    statusLeft =
      inspectorServerId && isRunning ? (
        <InspectorStatus inspector={inspector} />
      ) : (
        <StatusItem>
          <Pulse tone="off" />
          <span>Unavailable</span>
        </StatusItem>
      );
    statusRight = podName;
    body = !inspectorServerId ? (
      installs.length > 0 ? (
        <ConsoleState
          tone="info"
          testId={E2eTestId.McpInspectorNoConnection}
          title="No connection of yours to inspect"
          detail={
            <>
              The Inspector calls the server as the selected connection, with
              that connection's credentials — so it only offers your own
              connections and ones shared with you. Connect{" "}
              <strong className="text-slate-200">{serverName}</strong> yourself,
              or ask for a shared connection, to inspect it.
            </>
          }
        />
      ) : null
    ) : !isRunning ? (
      <PodNotRunningState status={status} purpose="inspector" />
    ) : (
      <InspectorBody inspector={inspector} />
    );
  } else {
    if (shellActive && shell.status === "connected") {
      actions = (
        <div className="flex items-center rounded-md bg-slate-900 p-0.5 ring-1 ring-slate-800 ring-inset">
          <SegButton
            active={shell.focusTerminal}
            onClick={() => shell.setFocusTerminal(true)}
            icon={<SquareTerminal />}
            label="Type"
            tip="Click inside the terminal to type and use the running app's controls."
          />
          <SegButton
            active={!shell.focusTerminal}
            onClick={() => shell.setFocusTerminal(false)}
            icon={<TextSelect />}
            label="Select text"
            tip="Select and copy text with the browser. Typing and clicks are not sent to the running app."
          />
        </div>
      );
    }
    statusLeft = <ShellStatus shell={shell} active={shellActive} />;
    statusRight = shell.command ? (
      <CommandChip command={shell.command} />
    ) : (
      podName
    );
    body = !canOpenShell ? (
      <ConsoleState
        tone="info"
        title="Shell access is limited to installation admins"
        detail="A shell runs commands inside the server's container, so it needs permission to manage MCP server installations."
      />
    ) : !isRunning ? (
      <PodNotRunningState status={status} purpose="shell" />
    ) : (
      <ShellBody shell={shell} />
    );
  }

  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[480px] flex-col overflow-hidden rounded-md border border-slate-900 bg-slate-950 text-slate-300 shadow-sm dark:border-slate-800">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-800 pr-1.5 pl-1.5 sm:gap-3 sm:pr-2">
        <InstanceSwitcher
          installs={selectableInstalls}
          totalCount={installs.length}
          credentialFiltered={tab === "inspector"}
          deploymentStatuses={deploymentStatuses}
          serverId={serverId}
          setServerId={setServerId}
          myEmail={myEmail}
        />
        <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          {actions}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">{body}</div>

      {/* Status bar. The left cluster keeps its natural width (its low-priority
          items drop out below breakpoints), and the right slot takes whatever
          is left, so the command chip is what truncates first. Nothing wraps. */}
      <footer className="flex h-7 shrink-0 items-stretch overflow-hidden border-t border-slate-800 bg-slate-900/60 font-mono text-[11px] whitespace-nowrap text-slate-400">
        <span className="flex shrink-0 items-center bg-slate-800/80 px-2.5 text-slate-200">
          {TAB_LABEL[tab]}
        </span>
        <div className="flex shrink-0 items-center gap-3 px-3">
          {statusLeft}
        </div>
        {statusRight && (
          <div className="flex min-w-0 flex-1 justify-end">
            <div className="flex min-w-0 items-center gap-2 border-l border-slate-800 pr-1 pl-3">
              {statusRight}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}

// ===================== top bar =====================

function InstanceSwitcher({
  installs,
  totalCount,
  credentialFiltered,
  deploymentStatuses,
  serverId,
  setServerId,
  myEmail,
}: {
  installs: McpLogsInstall[];
  /** All connections, before the Inspector's credential filter. */
  totalCount: number;
  credentialFiltered: boolean;
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  serverId: string | null;
  setServerId: (id: string) => void;
  myEmail: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const commandRef = useRef<HTMLDivElement>(null);
  const selected = installs.find((i) => i.id === serverId);
  const s = serverId ? deploymentStatuses[serverId] : undefined;
  const cs = connState(s);
  const hiddenCount = credentialFiltered ? totalCount - installs.length : 0;
  // Open the list even with one option when others were filtered out, so the
  // "why only this one" note stays reachable.
  const canOpen = installs.length > 1 || hiddenCount > 0;
  const searchable = installs.length > 6;

  const groups = useMemo(
    () => groupInstalls(installs, myEmail),
    [installs, myEmail],
  );
  const q = query.trim().toLowerCase();
  const visibleGroups = q
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter((i) =>
            connHaystack(i, deploymentStatuses[i.id]).includes(q),
          ),
        }))
        .filter((g) => g.items.length > 0)
    : groups;
  const counts = useMemo(() => {
    const c = { running: 0, starting: 0, failed: 0, off: 0 };
    for (const i of installs) {
      const st = connState(deploymentStatuses[i.id]);
      if (st === "running") c.running += 1;
      else if (st === "pending" || st === "waking" || st === "unknown")
        c.starting += 1;
      else if (st === "failed" || st === "degraded") c.failed += 1;
      else c.off += 1;
    }
    return c;
  }, [installs, deploymentStatuses]);

  const meta = [
    ownerLabel(selected, myEmail),
    s?.restartCount !== undefined
      ? `${s.restartCount} restart${s.restartCount === 1 ? "" : "s"}`
      : null,
    s?.podAge ? `up ${s.podAge}` : null,
  ].filter(Boolean) as string[];

  const identity = (
    <>
      <ConnDot state={cs} />
      <span className="truncate font-mono text-[13px] font-medium text-slate-100">
        {selected?.name ?? "—"}
      </span>
      {canOpen && (
        <>
          <span className="hidden shrink-0 rounded bg-slate-800 px-1.5 font-mono text-[10px] leading-4 tabular-nums text-slate-400 sm:inline">
            {credentialFiltered && hiddenCount > 0
              ? `${installs.length}/${totalCount}`
              : totalCount}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 text-slate-500 group-hover:text-slate-300" />
        </>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
      {canOpen ? (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
        >
          <PopoverTrigger asChild>
            <UnstyledButton
              aria-label={`Switch connection (${selected?.name ?? "none"} selected, ${installs.length} available)`}
              className="group flex h-7 min-w-0 items-center gap-2 rounded-md px-2 outline-none hover:bg-slate-800/70 focus-visible:ring-2 focus-visible:ring-slate-600 data-[state=open]:bg-slate-800/70"
            >
              {identity}
            </UnstyledButton>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="w-[23rem] max-w-[calc(100vw-24px)] overflow-hidden p-0"
            onOpenAutoFocus={(e) => {
              if (searchable) return;
              // No search box: focus the list itself so arrows/Enter work.
              e.preventDefault();
              commandRef.current?.focus();
            }}
          >
            <Command
              ref={commandRef}
              tabIndex={-1}
              shouldFilter={false}
              loop
              defaultValue={serverId ?? undefined}
              className="outline-none"
            >
              {searchable && (
                <CommandInput
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search name, owner, team or pod"
                  className="text-xs"
                />
              )}
              <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">
                  {credentialFiltered && hiddenCount > 0 ? (
                    <>
                      <span className="font-medium text-foreground tabular-nums">
                        {installs.length} of {totalCount}
                      </span>{" "}
                      usable as you
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-foreground tabular-nums">
                        {totalCount}
                      </span>{" "}
                      {totalCount === 1 ? "connection" : "connections"}
                    </>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2.5 font-mono tabular-nums">
                  <CountPip tone="running" n={counts.running} label="running" />
                  <CountPip
                    tone="starting"
                    n={counts.starting}
                    label="starting"
                  />
                  <CountPip tone="failed" n={counts.failed} label="failed" />
                  <CountPip tone="off" n={counts.off} label="not deployed" />
                </span>
              </div>
              <CommandList className="max-h-[min(360px,48dvh)]">
                <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
                  No connection matches “{query.trim()}”
                </CommandEmpty>
                {visibleGroups.map((g) => (
                  <CommandGroup
                    key={g.key}
                    heading={
                      <span className="flex items-center justify-between">
                        <span>{g.label}</span>
                        <span className="font-mono tabular-nums">
                          {g.items.length}
                        </span>
                      </span>
                    }
                  >
                    {g.items.map((install) => (
                      <SwitcherRow
                        key={install.id}
                        install={install}
                        status={deploymentStatuses[install.id]}
                        isSelected={install.id === serverId}
                        isMine={isMine(install, myEmail)}
                        onSelect={() => {
                          setServerId(install.id);
                          setOpen(false);
                          setQuery("");
                        }}
                      />
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
              {credentialFiltered && hiddenCount > 0 && (
                <div className="flex gap-2 border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                  <Info className="mt-px size-3 shrink-0" />
                  <span>
                    {hiddenCount} {hiddenCount === 1 ? "other" : "others"}{" "}
                    hidden. The Inspector calls the server with the connection's
                    own credential, so it offers only yours and ones shared with
                    you. Logs and Shell list all {totalCount}.
                  </span>
                </div>
              )}
              <div className="hidden items-center gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground sm:flex">
                <span>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> move
                </span>
                <span>
                  <Kbd>↵</Kbd> open
                </span>
                <span>
                  <Kbd>esc</Kbd> close
                </span>
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      ) : (
        <div
          className="flex h-7 min-w-0 items-center gap-2 px-2"
          title={s?.podName ?? undefined}
        >
          {identity}
        </div>
      )}
      <span
        className={cn(
          "shrink-0 text-xs",
          cs === "running" && "text-emerald-400",
          (cs === "failed" || cs === "degraded") && "text-red-400",
          (cs === "pending" || cs === "unknown") && "text-amber-400",
          (cs === "hibernated" || cs === "waking" || cs === "not_created") &&
            "text-slate-400",
        )}
      >
        {connStateLabel(cs)}
      </span>
      {meta.length > 0 && (
        <span className="hidden min-w-0 truncate text-xs text-slate-500 md:block">
          {meta.join("  ·  ")}
        </span>
      )}
    </div>
  );
}

function SwitcherRow({
  install,
  status,
  isSelected,
  isMine,
  onSelect,
}: {
  install: McpLogsInstall;
  status: McpDeploymentStatusEntry | undefined;
  isSelected: boolean;
  isMine: boolean;
  onSelect: () => void;
}) {
  const cs = connState(status);
  const ScopeIcon =
    install.scope === "org" ? Building2 : install.teamDetails ? Users : User;
  const owner =
    install.scope === "org"
      ? "Organization"
      : install.teamDetails
        ? `${install.teamDetails.name} team`
        : isMine
          ? "Personal · you"
          : (install.ownerEmail ?? "Personal");
  const problem =
    cs === "failed" || cs === "degraded"
      ? status?.message || "Failed"
      : cs === "pending"
        ? status?.message || null
        : null;
  return (
    <CommandItem
      value={install.id}
      onSelect={onSelect}
      className="gap-2.5 py-1.5"
      aria-current={isSelected ? "true" : undefined}
    >
      <ConnDot state={cs} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{install.name}</span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <ScopeIcon className="size-3 shrink-0" />
          <span className="truncate">{owner}</span>
          {problem && (
            <span
              className={cn(
                "shrink-0",
                cs === "pending"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400",
              )}
            >
              · {problem}
            </span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[10px] leading-4">
        {cs === "running" ? (
          <span className="tabular-nums text-muted-foreground">
            {status?.podAge ?? ""}
          </span>
        ) : (
          <StateTag state={cs} />
        )}
        {(status?.restartCount ?? 0) > 0 && (
          <span
            className={cn(
              "tabular-nums",
              (status?.restartCount ?? 0) >= 5
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground",
            )}
            title={`${status?.restartCount} restarts`}
          >
            ↻{status?.restartCount}
          </span>
        )}
      </span>
      <Check className={cn("size-3.5 shrink-0", !isSelected && "invisible")} />
    </CommandItem>
  );
}

function StateTag({ state }: { state: ConnState }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 font-sans font-medium",
        (state === "failed" || state === "degraded") &&
          "bg-red-500/10 text-red-600 dark:text-red-400",
        (state === "pending" || state === "unknown") &&
          "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        (state === "not_created" ||
          state === "hibernated" ||
          state === "waking") &&
          "bg-muted text-muted-foreground",
      )}
    >
      {connStateLabel(state)}
    </span>
  );
}

function CountPip({
  tone,
  n,
  label,
}: {
  tone: "running" | "starting" | "failed" | "off";
  n: number;
  label: string;
}) {
  if (n === 0) return null;
  return (
    <span className="flex items-center gap-1" title={`${n} ${label}`}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "running" && "bg-green-500",
          tone === "starting" && "bg-yellow-500",
          tone === "failed" && "bg-red-500",
          tone === "off" && "border border-muted-foreground",
        )}
      />
      <span className="sr-only">{label}</span>
      {n}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-0.5 inline-flex min-w-4 items-center justify-center rounded border bg-muted px-1 font-sans text-[10px] leading-4">
      {children}
    </kbd>
  );
}

// ===================== body states =====================

/** Why Inspector/Shell can't run yet, worded for the pod's actual state. */
function PodNotRunningState({
  status,
  purpose,
}: {
  status: McpDeploymentStatusEntry | undefined;
  purpose: "inspector" | "shell";
}) {
  const what =
    purpose === "inspector"
      ? "The Inspector talks to the live server"
      : "A shell runs inside the server's container";
  const cs = connState(status);
  if (cs === "failed" || cs === "degraded") {
    return (
      <ConsoleState
        tone="error"
        title={`Deployment failed${status?.message ? ` · ${status.message}` : ""}`}
        detail={
          <>
            {status?.error && (
              <span className="mb-2 block rounded border border-red-400/20 bg-red-400/5 px-2.5 py-1.5 text-left font-mono text-[11px] text-red-300/90">
                {status.error}
              </span>
            )}
            {what}, so it's unavailable until the pod is healthy. The Logs tab
            shows why it's restarting.
          </>
        }
      />
    );
  }
  if (cs === "pending" || cs === "waking" || cs === "unknown") {
    return (
      <ConsoleState
        tone="loading"
        title={
          cs === "waking"
            ? "Waking from idle"
            : `Pod is starting${status?.message ? ` · ${status.message}` : ""}`
        }
        detail={`${what}. This opens on its own once the pod is running.`}
      />
    );
  }
  if (cs === "hibernated") {
    return (
      <ConsoleState
        tone="info"
        title="Scaled down while idle"
        detail={`${what}. It wakes automatically on the next tool call.`}
      />
    );
  }
  return (
    <ConsoleState
      tone="info"
      title="Not deployed"
      detail={`This connection has no pod yet. ${what}, so it's available once it's deployed.`}
    />
  );
}

// ===================== helpers =====================

const TAB_LABEL: Record<McpServerConsoleTab, string> = {
  logs: "logs",
  inspector: "inspector",
  debug: "shell",
};

function ownerLabel(
  install: McpLogsInstall | undefined,
  myEmail: string | null,
) {
  if (!install) return null;
  if (install.scope === "org") return "Organization";
  if (install.teamDetails) return `${install.teamDetails.name} team`;
  if (isMine(install, myEmail)) return "Yours";
  return install.ownerEmail ?? null;
}

function isMine(install: McpLogsInstall, myEmail: string | null) {
  return (
    !!myEmail &&
    install.scope !== "org" &&
    !install.teamDetails &&
    install.ownerEmail?.toLowerCase() === myEmail.toLowerCase()
  );
}

/** Yours first, then team/org connections, then other people's. */
function groupInstalls(installs: McpLogsInstall[], myEmail: string | null) {
  const mine: McpLogsInstall[] = [];
  const shared: McpLogsInstall[] = [];
  const others: McpLogsInstall[] = [];
  for (const i of installs) {
    if (isMine(i, myEmail)) mine.push(i);
    else if (i.scope === "org" || i.teamDetails) shared.push(i);
    else others.push(i);
  }
  shared.sort((a, b) => {
    if ((a.scope === "org") !== (b.scope === "org"))
      return a.scope === "org" ? -1 : 1;
    return (a.teamDetails?.name ?? a.name).localeCompare(
      b.teamDetails?.name ?? b.name,
    );
  });
  others.sort((a, b) =>
    (a.ownerEmail ?? a.name).localeCompare(b.ownerEmail ?? b.name),
  );
  return [
    { key: "mine", label: "Yours", items: mine },
    { key: "shared", label: "Teams & organization", items: shared },
    { key: "others", label: "Other people's", items: others },
  ].filter((g) => g.items.length > 0);
}

function connHaystack(
  install: McpLogsInstall,
  status: McpDeploymentStatusEntry | undefined,
) {
  return [
    install.name,
    install.ownerEmail,
    install.teamDetails?.name,
    install.scope === "org" ? "organization org" : install.scope,
    status?.podName,
    status?.message,
    connStateLabel(connState(status)),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
