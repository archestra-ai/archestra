"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { BookOpen, Puzzle, Search, Server } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { SCOPE_META } from "@/components/scope-vocabulary";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils/tailwind";
import { skillDetailHref } from "../skills/_parts/skill-page-config";
import type { ConnectClient } from "./clients";
import type { ConnectChoices } from "./connect-choices";
import type {
  ConnectPageData,
  ConnectPageSkill,
  ConnectServer,
} from "./connect-page-data";
import { approxTokens, fmt, plural } from "./connect-page-parts";

type BrowseTab = "servers" | "skills" | "plugins";

/**
 * "See all": what the setup adds, one kind at a time. Each kind is a card with
 * its total, and picking one lists it below. Rows stay one line and link to
 * the item's own page, which holds everything else (a server's tools, a
 * skill's instructions).
 */
export function BrowseDialog({
  open,
  tab,
  focus,
  onTab,
  onOpenChange,
  data,
  client,
  choices,
}: {
  open: boolean;
  tab: BrowseTab;
  /** From a row on the profile card: the server or skill to bring into view. */
  focus: string | null;
  onTab: (t: BrowseTab) => void;
  onOpenChange: (v: boolean) => void;
  data: ConnectPageData;
  client: ConnectClient;
  choices: ConnectChoices;
}) {
  const lists = useBrowseLists({ open, tab, data, client });
  const parts = data.partsFor(client);
  const skillsOff = parts.skills && !choices.skills;
  const tools = data.servers.reduce((n, s) => n + s.toolCount, 0);
  const cards: {
    key: BrowseTab;
    icon: ReactNode;
    count: string;
    label: string;
    fact: string;
  }[] = [
    {
      key: "servers",
      icon: <Server />,
      count: fmt(data.servers.length),
      label: data.servers.length === 1 ? "MCP server" : "MCP servers",
      fact: data.progressive
        ? `${fmt(tools)} tools, loaded on demand`
        : `${fmt(tools)} ${plural(tools, "tool")}`,
    },
    {
      key: "skills",
      icon: <BookOpen />,
      count: data.skillsEnabled ? fmt(data.totalSkills) : "0",
      label: data.totalSkills === 1 ? "Skill" : "Skills",
      fact: !data.skillsEnabled
        ? "Not shared by your admin"
        : skillsOff
          ? "Not in this setup"
          : "Read when a task needs one",
    },
    ...(parts.plugins
      ? [
          {
            key: "plugins" as const,
            icon: <Puzzle />,
            count: fmt(lists.allPlugins.length),
            label: lists.allPlugins.length === 1 ? "Plugin" : "Plugins",
            fact: "Installed in the client",
          },
        ]
      : []),
  ];
  const skillsProblem = skillsBlocker(lists, data);
  const bringIntoView = (key: string) => (el: HTMLLIElement | null) => {
    if (el && open && key === focus) el.scrollIntoView({ block: "nearest" });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Sized to its rows, so a short list is a short dialog. */}
      <DialogContent className="max-h-[85dvh] max-w-2xl">
        <DialogHeader className="px-6">
          <DialogTitle>What {client.label} gets</DialogTitle>
          <DialogDescription className="sr-only">
            The MCP servers, skills and plugins this setup adds.
          </DialogDescription>
        </DialogHeader>
        <TabsPrimitive.Root
          value={tab}
          onValueChange={(v) => onTab(v as BrowseTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="space-y-3 px-6 pt-4">
            <TabsPrimitive.List
              aria-label="What the setup adds"
              className={cn(
                "grid gap-2",
                cards.length === 3 ? "grid-cols-3" : "grid-cols-2",
              )}
            >
              {cards.map((card) => (
                <TabsPrimitive.Trigger
                  key={card.key}
                  value={card.key}
                  className={cn(
                    "flex min-w-0 flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "hover:bg-muted/40 data-[state=active]:border-foreground/60 data-[state=active]:bg-muted/40 data-[state=active]:ring-1 data-[state=active]:ring-foreground/20",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
                    {card.icon}
                    {card.label}
                  </span>
                  <span className="text-xl font-semibold leading-tight tabular-nums">
                    {card.count}
                  </span>
                  <span className="w-full truncate text-[11px] text-muted-foreground max-sm:hidden">
                    {card.fact}
                  </span>
                </TabsPrimitive.Trigger>
              ))}
            </TabsPrimitive.List>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={lists.q}
                onChange={(e) => lists.setQ(e.target.value)}
                placeholder={`Search ${tab === "servers" ? "servers" : tab}`}
                aria-label={`Search ${tab === "servers" ? "servers" : tab}`}
                className="pl-8"
              />
            </div>
          </div>
          <DialogBody className="px-6 pt-3 pb-6">
            <TabsPrimitive.Content value="servers" className="outline-none">
              {data.allServers && (
                <p className="pb-2 text-xs text-muted-foreground">
                  New servers your org adds join automatically.
                </p>
              )}
              {lists.servers.length === 0 ? (
                <EmptyLine>
                  {data.servers.length === 0
                    ? "No MCP servers on this gateway yet."
                    : "No servers match."}
                </EmptyLine>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {lists.servers.map((server) => {
                    const tokens = serverTokens(data, server.key);
                    return (
                      <li
                        key={server.key}
                        ref={bringIntoView(server.key)}
                        className="flex items-center gap-3 px-3 py-2.5 text-sm"
                      >
                        <McpCatalogIcon
                          icon={server.icon}
                          catalogId={server.catalogId ?? undefined}
                          size={18}
                        />
                        <ServerName
                          server={server}
                          canRead={lists.canReadRegistry}
                        />
                        <span className="ml-auto shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {toolCountText(server)}
                          {tokens && (
                            <span className="block text-[11px] max-sm:hidden">
                              {tokens}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsPrimitive.Content>
            <TabsPrimitive.Content value="skills" className="outline-none">
              {skillsProblem ? (
                <EmptyLine>{skillsProblem}</EmptyLine>
              ) : (
                <>
                  <ul
                    className={cn(
                      "divide-y rounded-lg border",
                      skillsOff && "opacity-50",
                    )}
                  >
                    {lists.skills.map((skill) => (
                      <li
                        key={skill.id}
                        ref={bringIntoView(skill.id)}
                        className="flex items-center gap-3 px-3 py-2.5 text-sm"
                      >
                        <div className="min-w-0 flex-1">
                          <SkillName
                            skill={skill}
                            canRead={lists.canReadSkills === true}
                          />
                          {skill.description && (
                            <p className="truncate text-xs text-muted-foreground">
                              {skill.description}
                            </p>
                          )}
                        </div>
                        <ScopeText scope={skill.scope} />
                      </li>
                    ))}
                  </ul>
                  {lists.moreSkills && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 w-full"
                      disabled={lists.skillsFetching}
                      onClick={lists.loadMoreSkills}
                    >
                      {`Show ${fmt(Math.min(PAGE, lists.skillTotal - lists.skills.length))} more`}
                    </Button>
                  )}
                </>
              )}
            </TabsPrimitive.Content>
            {parts.plugins && (
              <TabsPrimitive.Content value="plugins" className="outline-none">
                {lists.plugins.length === 0 ? (
                  <EmptyLine>No plugins match.</EmptyLine>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {lists.plugins.map((plugin) => (
                      <li key={plugin.id} className="px-3 py-2.5 text-sm">
                        {/* The plugin's own page shows what it contains. */}
                        <Link
                          href={`/plugins/${encodeURIComponent(plugin.id)}`}
                          className={LINK_CLASS}
                        >
                          {plugin.name}
                        </Link>
                        {plugin.description && (
                          <p className="truncate text-xs text-muted-foreground">
                            {plugin.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </TabsPrimitive.Content>
            )}
          </DialogBody>
        </TabsPrimitive.Root>
      </DialogContent>
    </Dialog>
  );
}

// ===

const PAGE = 20;

const LINK_CLASS =
  "truncate font-medium underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground";

/** Everything the dialog lists, filtered by its one search box. */
function useBrowseLists(params: {
  open: boolean;
  tab: BrowseTab;
  data: ConnectPageData;
  client: ConnectClient;
}) {
  const { open, tab, data, client } = params;
  const [q, setQ] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSkillSearch(q);
      setLimit(PAGE);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setSkillSearch("");
      setLimit(PAGE);
    }
  }, [open]);
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const { data: canReadRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const skillQuery = useSkillsPaginated(
    {
      limit,
      offset: 0,
      search: skillSearch || undefined,
      includeContent: false,
    },
    {
      enabled:
        open &&
        tab === "skills" &&
        data.skillsEnabled &&
        canReadSkills === true,
    },
  );
  const needle = q.trim().toLowerCase();
  const allPlugins = data.pluginsFor(client);
  const skills = skillQuery.data?.data ?? [];
  const skillTotal = skillQuery.data?.pagination.total ?? 0;
  return {
    q,
    setQ,
    servers: data.servers.filter((s) => s.name.toLowerCase().includes(needle)),
    allPlugins,
    plugins: allPlugins.filter((p) =>
      `${p.name} ${p.description ?? ""}`.toLowerCase().includes(needle),
    ),
    skills,
    skillTotal,
    skillsPending: skillQuery.isPending,
    skillsError: skillQuery.isError,
    skillsFetching: skillQuery.isFetching,
    moreSkills: skills.length < skillTotal,
    loadMoreSkills: () => setLimit((current) => current + PAGE),
    canReadSkills,
    canReadRegistry: canReadRegistry === true,
  };
}

/** The name, linked to the server's registry page when the reader may open it. */
function ServerName({
  server,
  canRead,
}: {
  server: ConnectServer;
  canRead: boolean;
}) {
  if (server.catalogId && canRead)
    return (
      <Link
        href={`/mcp/registry/${server.catalogId}`}
        className={cn(LINK_CLASS, "min-w-0")}
      >
        {server.name}
      </Link>
    );
  return <span className="min-w-0 truncate font-medium">{server.name}</span>;
}

function SkillName({
  skill,
  canRead,
}: {
  skill: ConnectPageSkill;
  canRead: boolean;
}) {
  if (canRead)
    return (
      <Link
        href={skillDetailHref(skill.id)}
        className={cn(LINK_CLASS, "block")}
      >
        {skill.name}
      </Link>
    );
  return <span className="block truncate font-medium">{skill.name}</span>;
}

/** "24 tools", or the truth when the gateway hasn't discovered any yet. */
function toolCountText(server: ConnectServer) {
  return server.toolCount === 0
    ? "Tools not discovered yet"
    : `${fmt(server.toolCount)} ${plural(server.toolCount, "tool")}`;
}

function serverTokens(data: ConnectPageData, key: string) {
  if (!data.toolTokens || data.progressive) return null;
  const tokens = data.toolTokens.byServer[key];
  return tokens ? approxTokens(tokens) : null;
}

function ScopeText({ scope }: { scope: ConnectPageSkill["scope"] }) {
  const { label, icon: Icon } = SCOPE_META[scope];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <Icon className="size-3" />
      {label}
    </span>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Why the skills list is empty or missing, or null when it can show. */
function skillsBlocker(
  lists: ReturnType<typeof useBrowseLists>,
  data: ConnectPageData,
) {
  if (lists.canReadSkills === false) return "You don’t have access to skills.";
  if (!data.skillsEnabled)
    return "Your admin hasn't shared skills with agents yet.";
  if (lists.skillsPending) return "Loading skills…";
  if (lists.skillsError) return "Skills could not be loaded.";
  if (lists.skills.length === 0)
    return data.totalSkills === 0
      ? "No skills in your org yet."
      : "No skills match.";
  return null;
}
