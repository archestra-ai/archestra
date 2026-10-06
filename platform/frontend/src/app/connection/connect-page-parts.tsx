"use client";

// Connect page pieces: picker, dialogs, helpers.

import {
  BookOpen,
  Check,
  ChevronDown,
  Cpu,
  Search,
  Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
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
import { cn } from "@/lib/utils/tailwind";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";
import type { ConnectChoices } from "./connect-choices";
import type { ConnectPageData, ConnectPageSkill } from "./connect-page-data";
import { setupModeFor } from "./manual-setup";

const MODAL_ROW_CAP = 200;

// === Agent picker: the searchable list behind "Other agents" ===

export function AgentSearch({
  data,
  selectedId,
  onPick,
  children,
}: {
  data: ConnectPageData;
  selectedId: string;
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
                {c.id === selectedId && <Check className="size-3.5" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// === Include dialog: the two parts a user can turn off ===

/**
 * Tools are always included (connecting without them adds nothing), so the
 * only switches are skills and model routing, when the agent supports them.
 */
export function IncludeDialog({
  open,
  onOpenChange,
  data,
  client,
  choices,
  onChoice,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: ConnectPageData;
  client: ConnectClient;
  choices: ConnectChoices;
  onChoice: (part: keyof ConnectChoices, value: boolean) => void;
}) {
  const parts = data.partsFor(client);
  const generic = setupModeFor(client) !== "prompt";
  const switches: {
    part: keyof ConnectChoices;
    icon: ReactNode;
    label: string;
    detail: string;
  }[] = [];
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="px-4">
          <DialogTitle>Choose what to include</DialogTitle>
          <DialogDescription>
            {generic
              ? "Your agent asks before changing anything."
              : "You confirm it again in the browser before anything changes."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="divide-y rounded-lg border">
            <li className="flex items-center gap-3 px-3 py-2.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
              <Wrench />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Tools</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {fmt(data.totalTools)} {plural(data.totalTools, "tool")} from{" "}
                  {fmt(data.servers.length)} MCP{" "}
                  {plural(data.servers.length, "server")}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">Always on</span>
            </li>
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
                  <span className="block text-sm font-medium">{sw.label}</span>
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
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// === Browse dialog: "See all", read-only lists ===

type BrowseTab = "servers" | "skills" | "plugins";

export function BrowseDialog({
  open,
  tab,
  focus,
  onTab,
  onOpenChange,
  data,
  client,
  skills,
  choices,
}: {
  open: boolean;
  tab: BrowseTab;
  /** Server to open expanded (its tools), from a row on the profile card. */
  focus: string | null;
  onTab: (t: BrowseTab) => void;
  onOpenChange: (v: boolean) => void;
  data: ConnectPageData;
  client: ConnectClient;
  skills: ConnectPageSkill[];
  choices: ConnectChoices;
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
  const tabs: [BrowseTab, string, string][] = [
    ["servers", "MCP servers", fmt(data.servers.length)],
    ["skills", "Skills", data.skillsEnabled ? fmt(data.totalSkills) : "off"],
    ...(parts.plugins
      ? [
          ["plugins", "Plugins", fmt(plugins.length)] as [
            BrowseTab,
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
          <DialogTitle>What {client.label} gets</DialogTitle>
          <DialogDescription className="sr-only">
            The MCP servers, skills and plugins this setup adds.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={tab} onValueChange={(v) => onTab(v as BrowseTab)}>
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
            <div className="space-y-3">
              {data.allServers && (
                <p className="text-xs text-muted-foreground">
                  New servers your org adds join automatically.
                </p>
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
                    Skills are turned off. Turn them on under Choose what to
                    include.
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
            <div className="space-y-3">
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
