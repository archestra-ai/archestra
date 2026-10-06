"use client";

// Connect page pieces: picker, copy line, copy prompt, undo dialog,
// disconnect and manage dialogs, helpers.

import {
  isOAuthRecognisedClient,
  startupGuardStem,
} from "@archestra/shared/connection-setup";
import {
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  HardDrive,
  Puzzle,
  Search,
  Unplug,
  Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { copyToClipboard } from "@/lib/clipboard";
import { useDisconnectConnectedClient } from "@/lib/connected-client.query";
import { cn } from "@/lib/utils/tailwind";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";
import type { ConnectChoices } from "./connect-choices";
import type {
  ConnectPageData,
  ConnectPageSkill,
  ConnectServer,
} from "./connect-page-data";
import { setupModeFor } from "./manual-setup";
import { detectPlatform } from "./platform.utils";

const MODAL_ROW_CAP = 200;

// === Agent picker: the searchable list behind "Other agents" ===

export function AgentSearch({
  data,
  selectedId,
  connectedIds,
  onPick,
  children,
}: {
  data: ConnectPageData;
  selectedId: string;
  connectedIds: Set<string>;
  onPick: (id: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const featuredIds = new Set(data.featuredClients.map((c) => c.id));
  // One flat list of the non-featured agents by name, filtered here (not
  // by cmdk, which reorders by score) so Generic client always stays last,
  // whatever the search, as the fallback.
  const needle = query.trim().toLowerCase();
  const agents = data.clients
    .filter(
      (c) =>
        !featuredIds.has(c.id) &&
        c.id !== "generic" &&
        `${c.label} ${c.sub}`.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  const generic = data.clients.find((c) => c.id === "generic");
  const shown = generic ? [...agents, generic] : agents;
  const choose = (id: string) => {
    onPick(id);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search agents"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-80">
            <CommandEmpty className="px-3 py-4 text-sm text-muted-foreground">
              No agents match.
            </CommandEmpty>
            {shown.map((c) => (
              <CommandItem
                key={c.id}
                value={c.id}
                onSelect={() => choose(c.id)}
                className="gap-2"
              >
                <ClientIcon client={c} size={22} />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {connectedIds.has(c.id) && (
                  <span
                    className="size-1.5 rounded-full bg-emerald-500"
                    title="Connected"
                  />
                )}
                {c.id === selectedId && <Check className="size-3.5" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// === Copy line ===

export function CopyLine({
  text,
  label,
  primary,
}: {
  text: string;
  label: string;
  primary?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-1.5 pl-3">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{text}</code>
      <Button
        size="sm"
        variant={primary ? "default" : "outline"}
        className="shrink-0"
        onClick={async () => {
          try {
            await copyToClipboard(text);
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          } catch {
            toast.error(
              "Could not copy. Select the text and copy it manually.",
            );
          }
        }}
      >
        {done ? <Check /> : <Copy />}
        {done ? "Copied" : label}
      </Button>
    </div>
  );
}

// === Copy prompt: the text gets the width, the copy is one icon ===

function CopyPrompt({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative rounded-lg border bg-muted/40 py-2.5 pr-11 pl-3">
      <code className="block font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </code>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Copy prompt"
        title={done ? "Copied" : "Copy prompt"}
        className="absolute top-1.5 right-1.5 size-7 text-muted-foreground hover:text-foreground"
        onClick={async () => {
          try {
            await copyToClipboard(text);
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          } catch {
            toast.error(
              "Could not copy. Select the text and copy it manually.",
            );
          }
        }}
      >
        {done ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

// === Undo, before connecting: what connecting adds, and how it comes off ===

export function UndoDialog({
  data,
  client,
  children = "Disconnect anytime",
}: {
  data: ConnectPageData;
  client: ConnectClient;
  /** The trigger's label. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <UnstyledButton
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {children}
      </UnstyledButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader className="px-4">
            <DialogTitle className="flex items-center gap-2.5">
              <ClientIcon client={client} size={22} />
              Disconnecting {client.label}
            </DialogTitle>
            <DialogDescription>
              Once connected, you can always disconnect here, under Manage: one
              prompt cleans up your computer, then you revoke access.
            </DialogDescription>
          </DialogHeader>
          <DisconnectSteps
            data={data}
            client={client}
            revoke={
              <p className="text-muted-foreground">
                Under Manage on this page, open Disconnect and press Revoke
                access. <RevokeEffect client={client} />
              </p>
            }
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Startup check file stem under ~/.archestra, for clients that install one. */
/** What the setup added to this agent, and the prompt that removes it. */
function DisconnectSteps({
  data,
  client,
  revoke,
}: {
  data: ConnectPageData;
  client: ConnectClient;
  /** Step 2's body: how, or the button, to revoke access. */
  revoke: ReactNode;
}) {
  const fp = data.footprintFor(client);
  const manualOnly = setupModeFor(client) === "manual";
  const guard = startupGuardStem(client.id);
  const [windows, setWindows] = useState(false);
  useEffect(() => setWindows(detectPlatform() === "windows"), []);
  const local = [
    ...(fp.skillsInstalled > 0
      ? [`${fmt(fp.skillsInstalled)} ${plural(fp.skillsInstalled, "skill")}`]
      : []),
    ...fp.localChanges,
  ];
  const cleanup = (
    <div className="space-y-3">
      {local.length > 0 && (
        <div className="space-y-2">
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
        </div>
      )}
      <div className="space-y-2">
        <p className="text-muted-foreground">
          {manualOnly
            ? `In ${nameOf(client)}, delete the MCP Client Tool node you added.`
            : `Paste this into ${nameOf(client)} to remove it:`}
        </p>
        {!manualOnly && <CopyPrompt text={data.disconnectPrompt(client)} />}
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

// === Disconnect: clean up this computer, then revoke access ===

/** What Revoke access does, in both disconnect dialogs. */
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
      skill links it created. Other agents keep their gateway sign-in until it
      expires; the cleanup prompt removes access on the machine.
    </span>
  );
}

export function DisconnectDialog({
  data,
  client,
  onOpenChange,
}: {
  data: ConnectPageData;
  client: ConnectClient | null;
  onOpenChange: (v: boolean) => void;
}) {
  const record = client
    ? data.connected.find((c) => c.clientId === client.id)
    : undefined;
  const disconnect = useDisconnectConnectedClient();
  // The cleanup prompt ends by sending the user back here to revoke access.
  // Revoking drops the agent from `data.connected`, which closes the dialog.
  return (
    <Dialog open={!!client && !!record} onOpenChange={onOpenChange}>
      {client && record && (
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
                {record.deviceNames.length > 1 && (
                  <p className="text-muted-foreground">
                    Connected on {record.deviceNames.join(", ")}. Revoking cuts
                    all of them; run the cleanup prompt on each.
                  </p>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate(record.clientId)}
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

// === Manage: every connected agent, one row each ===

export function ManageDialog({
  open,
  onOpenChange,
  data,
  onDisconnect,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: ConnectPageData;
  onDisconnect: (client: ConnectClient) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="px-4">
          <DialogTitle>Connected agents</DialogTitle>
          <DialogDescription>
            Disconnecting one leaves the others as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {data.connected.length === 0 ? (
            <Empty>No agents connected yet.</Empty>
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-lg border">
              {data.connected.map((a) => (
                <li
                  key={a.clientId}
                  className="flex items-center gap-3 py-2 pr-2 pl-3"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <ClientIcon client={a.client} size={26} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {a.client.label}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                        <span
                          className="truncate"
                          title={a.deviceNames.join(", ") || undefined}
                        >
                          {a.deviceNames.length > 0
                            ? `Connected · on ${a.deviceNames.join(", ")}`
                            : "Connected"}
                        </span>
                      </span>
                    </span>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      onOpenChange(false);
                      onDisconnect(a.client);
                    }}
                  >
                    <Unplug />
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// === Include dialog: what the setup adds, with the real switches ===

type IncludeTab = "servers" | "skills" | "plugins";

export function IncludeDialog({
  open,
  tab,
  focus,
  onTab,
  onOpenChange,
  data,
  client,
  skills,
  choices,
  onChoice,
}: {
  open: boolean;
  tab: IncludeTab;
  /** Server to open expanded (its tools), from a row on the profile card. */
  focus: string | null;
  onTab: (t: IncludeTab) => void;
  onOpenChange: (v: boolean) => void;
  data: ConnectPageData;
  client: ConnectClient;
  skills: ConnectPageSkill[];
  choices: ConnectChoices;
  onChoice: (part: keyof ConnectChoices, value: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setExpanded(focus);
      setQ("");
    }
  }, [open, focus]);
  const parts = data.partsFor(client);
  const plugins = data.pluginsFor(client);
  const generic = setupModeFor(client) !== "prompt";
  const needle = q.toLowerCase();
  const serverMatch = data.servers.filter((s) =>
    s.name.toLowerCase().includes(needle),
  );
  const skillMatch = skills.filter((s) =>
    `${s.name} ${s.description}`.toLowerCase().includes(needle),
  );
  const pluginMatch = plugins.filter((p) =>
    `${p.name} ${p.description ?? ""}`.toLowerCase().includes(needle),
  );
  const switches: {
    part: keyof ConnectChoices;
    icon: ReactNode;
    label: string;
    detail: string;
  }[] = [];
  if (parts.tools)
    switches.push({
      part: "tools",
      icon: <Wrench />,
      label: "Tools",
      detail: `${fmt(data.totalTools)} ${plural(data.totalTools, "tool")} from ${fmt(data.servers.length)} MCP ${plural(data.servers.length, "server")}`,
    });
  if (parts.skills)
    switches.push({
      part: "skills",
      icon: <BookOpen />,
      label: "Skills",
      detail: `${fmt(data.totalSkills)} ${plural(data.totalSkills, "skill")}, loaded when a task needs one`,
    });
  if (parts.proxy)
    switches.push({
      part: "proxy",
      icon: <Cpu />,
      label: "Model routing",
      detail: `Model requests go through ${data.appName}. Same models.`,
    });
  if (parts.plugins)
    switches.push({
      part: "plugins",
      icon: <Puzzle />,
      label: "Plugins",
      detail: `${fmt(plugins.length)} ${plural(plugins.length, "plugin")} for ${client.label}`,
    });
  const tabs: [IncludeTab, string, string][] = [
    ["servers", "MCP servers", fmt(data.servers.length)],
    ["skills", "Skills", data.skillsEnabled ? fmt(data.totalSkills) : "off"],
    ...(parts.plugins
      ? [
          ["plugins", "Plugins", fmt(plugins.length)] as [
            IncludeTab,
            string,
            string,
          ],
        ]
      : []),
  ];
  const off = (part: keyof ConnectChoices) => parts[part] && !choices[part];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="px-4">
          <DialogTitle>What your agent connects to</DialogTitle>
          <DialogDescription>
            {generic
              ? "Turn off what you don't need. Your agent asks before changing anything."
              : "Turn off what you don't need. You confirm it again in the browser before anything changes."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {switches.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {switches.map((sw) => (
                <li
                  key={sw.part}
                  className="flex items-center gap-3 px-3 py-2.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
                >
                  {sw.icon}
                  <label
                    htmlFor={`include-${sw.part}`}
                    className="min-w-0 flex-1 cursor-pointer"
                  >
                    <span className="block text-sm font-medium">
                      {sw.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {sw.detail}
                    </span>
                  </label>
                  <Switch
                    id={`include-${sw.part}`}
                    checked={choices[sw.part]}
                    onCheckedChange={(v) => onChoice(sw.part, v)}
                    aria-label={`Include ${sw.label.toLowerCase()}`}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={tab} onValueChange={(v) => onTab(v as IncludeTab)}>
              <TabsList>
                {tabs.map(([value, label, count]) => (
                  <TabsTrigger key={value} value={value}>
                    {label}{" "}
                    <span className="tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="relative min-w-[12rem] flex-1">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${tab === "servers" ? "servers" : tab}`}
                className="pl-8"
              />
            </div>
          </div>

          {tab === "servers" ? (
            <div className={cn("space-y-3", off("tools") && "opacity-50")}>
              {off("tools") ? (
                <p className="text-xs text-muted-foreground">
                  Tools are left out. Turn them on above to include these.
                </p>
              ) : (
                data.allServers && (
                  <p className="text-xs text-muted-foreground">
                    New servers your org adds join automatically.
                  </p>
                )
              )}
              <ul className="divide-y rounded-lg border">
                {serverMatch.slice(0, MODAL_ROW_CAP).map((s) => {
                  const isOpen = expanded === s.key;
                  return (
                    <li
                      key={s.key}
                      ref={(el) => {
                        if (el && isOpen && s.key === focus)
                          el.scrollIntoView({ block: "nearest" });
                      }}
                    >
                      <UnstyledButton
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : s.key)}
                        aria-expanded={isOpen}
                        className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-sm hover:text-foreground"
                      >
                        <McpCatalogIcon
                          icon={s.icon}
                          catalogId={s.catalogId ?? undefined}
                          size={18}
                        />
                        <span className="truncate">{s.name}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {s.toolCount} {plural(s.toolCount, "tool")}
                        </span>
                        <ChevronDown
                          className={cn(
                            "ml-auto size-3.5 text-muted-foreground transition-transform",
                            isOpen && "rotate-180",
                          )}
                        />
                      </UnstyledButton>
                      {isOpen && (
                        <div className="flex flex-wrap gap-1 px-3 pb-3 pl-10">
                          {s.tools.slice(0, 40).map((t) => (
                            <span
                              key={t.name}
                              title={t.description ?? undefined}
                              className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                            >
                              {t.name}
                            </span>
                          ))}
                          {s.tools.length > 40 && (
                            <span className="px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {s.tools.length - 40} more
                            </span>
                          )}
                          {s.tools.length === 0 && (
                            <span className="text-xs text-muted-foreground">
                              Tool names load after the server is installed.
                            </span>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
                {serverMatch.length === 0 && (
                  <Empty>
                    {data.servers.length === 0
                      ? "No MCP servers on this gateway yet."
                      : "No servers match."}
                  </Empty>
                )}
              </ul>
              {serverMatch.length > MODAL_ROW_CAP && (
                <p className="text-xs text-muted-foreground">
                  Showing {MODAL_ROW_CAP} of {serverMatch.length}. Search to
                  narrow down.
                </p>
              )}
            </div>
          ) : tab === "skills" ? (
            !data.skillsEnabled ? (
              <Empty>Your admin hasn't shared skills with agents yet.</Empty>
            ) : (
              <div className={cn("space-y-3", off("skills") && "opacity-50")}>
                {off("skills") && (
                  <p className="text-xs text-muted-foreground">
                    Skills are left out. Turn them on above to include these.
                  </p>
                )}
                <ul className="divide-y rounded-lg border">
                  {skillMatch.slice(0, MODAL_ROW_CAP).map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs">{s.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {s.description}
                        </div>
                      </div>
                      <span className="text-[11px] capitalize text-muted-foreground">
                        {s.scope}
                      </span>
                    </li>
                  ))}
                  {skillMatch.length === 0 && (
                    <Empty>
                      {skills.length === 0
                        ? "No skills in your org yet."
                        : "No skills match."}
                    </Empty>
                  )}
                </ul>
                {skillMatch.length > MODAL_ROW_CAP && (
                  <p className="text-xs text-muted-foreground">
                    Showing {MODAL_ROW_CAP} of {fmt(skillMatch.length)}. Search
                    to narrow down.
                  </p>
                )}
              </div>
            )
          ) : (
            <div className={cn("space-y-3", off("plugins") && "opacity-50")}>
              <ul className="divide-y rounded-lg border">
                {pluginMatch.map((p) => (
                  <li key={p.id} className="px-3 py-2">
                    <div className="text-sm">{p.name}</div>
                    {p.description && (
                      <div className="truncate text-xs text-muted-foreground">
                        {p.description}
                      </div>
                    )}
                  </li>
                ))}
                {pluginMatch.length === 0 && <Empty>No plugins match.</Empty>}
              </ul>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function InfoDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="px-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        <DialogBody className="text-sm text-muted-foreground">
          {children}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

// === Helpers ===

/**
 * The first thing to try after connecting: one walkthrough of what the agent
 * got, rather than example tasks. null when nothing was included.
 */
export function suggestFirstPrompt(
  appName: string,
  servers: ConnectServer[],
  skills: ConnectPageSkill[],
): string | null {
  if (servers.length === 0 && skills.length === 0) return null;
  return `Summarize the tools and skills you got from ${appName} and show me one thing you can do with them.`;
}

export function nameOf(client: ConnectClient) {
  return client.id === "generic" ? "your agent" : client.label;
}

export function plural(n: number, word: string) {
  return n === 1 ? word : `${word}s`;
}

export function fmt(n: number) {
  return n.toLocaleString("en-US");
}

/** How the included tools reach the agent: on demand, or all at start. */
export function toolLoading(data: ConnectPageData, tools: number) {
  if (tools === 0) return "No tools included";
  return data.progressive
    ? "Tools load on demand"
    : `All ${fmt(tools)} ${plural(tools, "tool")} load when a session starts`;
}
