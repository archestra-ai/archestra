"use client";

// Connect page pieces: picker, dialogs, helpers.

import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Search,
} from "lucide-react";
import dynamic from "next/dynamic";
import { type ReactNode, useEffect, useState } from "react";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useSkill } from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils/tailwind";
import { ClientIcon } from "./client-icon";
import type { ConnectClient } from "./clients";
import type { ConnectChoices } from "./connect-choices";
import type { ConnectPageData, ConnectPageSkill } from "./connect-page-data";

const MODAL_ROW_CAP = 200;

// The markdown renderer is large; only a skill being read needs it.
const Response = dynamic(
  () => import("@/components/ai-elements/response").then((m) => m.Response),
  { ssr: false },
);

// === Agent picker: the searchable list behind "Other agents" ===

export function AgentSearch({
  data,
  selectedId,
  lastConnectedId,
  onPick,
  children,
}: {
  data: ConnectPageData;
  selectedId: string;
  /** The agent the user connected last, marked in the list. */
  lastConnectedId?: string;
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
                {c.id === lastConnectedId && (
                  <History
                    aria-label="Last connected"
                    className="size-3.5 text-muted-foreground"
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

// === Browse dialog: "See all", the lists plus the skills switch ===

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
  /**
   * From a row on the profile card: the server to open expanded (its tools),
   * or the skill to open.
   */
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
  const [openSkill, setOpenSkill] = useState<ConnectPageSkill | null>(null);
  // Only on open: switching tabs inside the dialog keeps what's open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
  useEffect(() => {
    if (open) {
      setExpanded(tab === "servers" ? focus : null);
      setOpenSkill(
        tab === "skills" && focus
          ? (skills.find((s) => s.id === focus) ?? null)
          : null,
      );
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
  const skillsOff = parts.skills && !choices.skills;
  const reading = tab === "skills" && openSkill;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(85dvh,46rem)] max-w-3xl">
        <DialogHeader className="px-6">
          <DialogTitle>What {client.label} gets</DialogTitle>
          <DialogDescription className="sr-only">
            The MCP servers, skills and plugins this setup adds.
          </DialogDescription>
        </DialogHeader>
        {reading ? (
          <SkillReader skill={openSkill} onBack={() => setOpenSkill(null)} />
        ) : (
          <>
            {/* Tabs and search stay put; only the list scrolls. */}
            <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
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
            <DialogBody className="space-y-3 px-6 pb-6">
              {tab === "servers" ? (
                <>
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
                            className="flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/50"
                          >
                            <McpCatalogIcon
                              icon={s.icon}
                              catalogId={s.catalogId ?? undefined}
                              size={18}
                            />
                            <span className="truncate">{s.name}</span>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {s.toolCount} {plural(s.toolCount, "tool")}
                              <span>{serverCost(data, s.key)}</span>
                            </span>
                            <ChevronDown
                              className={cn(
                                "ml-auto size-3.5 text-muted-foreground transition-transform",
                                isOpen && "rotate-180",
                              )}
                            />
                          </UnstyledButton>
                          {isOpen && (
                            <div className="flex flex-wrap gap-1 px-4 pb-3 pl-11">
                              {s.tools.slice(0, 40).map((t) => (
                                <span
                                  key={t.name}
                                  title={t.description ?? undefined}
                                  className="rounded border bg-muted/40 px-1.5 py-0.5 text-xs"
                                >
                                  {t.name}
                                </span>
                              ))}
                              {s.tools.length > 40 && (
                                <span className="px-1.5 py-0.5 text-xs text-muted-foreground">
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
                </>
              ) : tab === "skills" ? (
                !data.skillsEnabled ? (
                  <Empty>
                    Your admin hasn't shared skills with agents yet.
                  </Empty>
                ) : (
                  <>
                    <ul
                      className={cn(
                        "divide-y rounded-lg border",
                        skillsOff && "opacity-50",
                      )}
                    >
                      {skillMatch.slice(0, MODAL_ROW_CAP).map((s) => (
                        <li key={s.id}>
                          <UnstyledButton
                            type="button"
                            onClick={() => setOpenSkill(s)}
                            className="flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm">{s.name}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {s.description}
                              </span>
                            </span>
                            <span className="text-xs capitalize text-muted-foreground">
                              {s.scope}
                            </span>
                            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                          </UnstyledButton>
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
                        Showing {MODAL_ROW_CAP} of {fmt(skillMatch.length)}.
                        Search to narrow down.
                      </p>
                    )}
                  </>
                )
              ) : (
                <ul className="divide-y rounded-lg border">
                  {pluginMatch.map((p) => (
                    <li key={p.id} className="px-4 py-2.5">
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
              )}
            </DialogBody>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One skill in full: its SKILL.md, read in place of the list. */
function SkillReader({
  skill,
  onBack,
}: {
  skill: ConnectPageSkill;
  onBack: () => void;
}) {
  const { data: detail, isLoading } = useSkill(skill.id);
  const body = detail?.content ? stripFrontmatter(detail.content) : "";
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-6 pt-4">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft />
          <span className="sr-only">Back to skills</span>
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {skill.name}
        </span>
        <span className="text-xs capitalize text-muted-foreground">
          {skill.scope}
        </span>
      </div>
      <DialogBody className="space-y-4 px-6 pb-6">
        {skill.description && (
          <p className="text-sm text-muted-foreground">{skill.description}</p>
        )}
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : body ? (
          <div className="rounded-lg border p-5 text-sm">
            <Response>{body}</Response>
          </div>
        ) : (
          <Empty>This skill's instructions can't be shown.</Empty>
        )}
      </DialogBody>
    </>
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

/** A token estimate, rounded so it doesn't read as exact: "~3.2K tokens". */
export function approxTokens(n: number) {
  if (n < 1000) return `~${Math.max(100, Math.round(n / 100) * 100)} tokens`;
  const k = n / 1000;
  return `~${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : fmt(Math.round(k))}K tokens`;
}

/** One server's share of the context: its tokens, or that it loads when used. */
function serverCost(data: ConnectPageData, key: string) {
  if (!data.toolTokens) return "";
  if (data.progressive) return " · on demand";
  const tokens = data.toolTokens.byServer[key];
  return tokens ? ` · ${approxTokens(tokens)}` : "";
}

/** A SKILL.md body without its YAML frontmatter (name, description). */
function stripFrontmatter(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
