"use client";

import { ChevronDown, ChevronsUpDown, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { PluginSourceGlyph } from "@/app/plugins/_parts/plugin-source-icon";
import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { PluginListItem } from "@/lib/plugins/plugin.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * How the setup's models authenticate, which the admin decides:
 * admin-key — a virtual key backed by the keys an admin mapped for the client;
 * own-key — the user's own provider key or subscription (only the base URL changes);
 * all-providers — one virtual key for every mapped or primary provider;
 * per-user — the user connects their own account (GitHub Copilot);
 * unavailable — nothing can back routing.
 */
export type ConsentProxyMode =
  | "admin-key"
  | "own-key"
  | "all-providers"
  | "per-user"
  | "unavailable";

/** The optional setup choices on the connection approval page, collapsed by default. */
export function ConnectionConsentOptions({
  open,
  onOpenChange,
  clientLabel,
  tools,
  proxy,
  skills,
  plugins,
  platform,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientLabel: string;
  tools: {
    gateways: AgentSelectorAgent[];
    selectedGatewayId: string;
    onGatewaySelect: (id: string) => void;
  } | null;
  proxy: {
    include: boolean;
    setInclude: (value: boolean) => void;
    mode: ConsentProxyMode;
    providerLabels: string[];
    /** Provider choice, offered only for the user's own key. */
    providerPicker: ReactNode;
    modelPicker: ReactNode;
  } | null;
  skills: {
    include: boolean;
    setInclude: (value: boolean) => void;
    names: string[];
  } | null;
  plugins: {
    all: PluginListItem[];
    selectedIds: ReadonlySet<string>;
    setSelectedIds: (ids: ReadonlySet<string>) => void;
  } | null;
  platform: ReactNode;
}) {
  const proxyOn = !!proxy?.include && proxy.mode !== "unavailable";
  const pluginsOn = !!plugins && plugins.selectedIds.size > 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="mb-4 overflow-hidden rounded-lg border bg-card text-sm shadow-xs"
    >
      <CollapsibleTrigger asChild>
        <UnstyledButton
          className={cn(
            "flex h-10 w-full items-center gap-2 px-4 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
            open && "border-b",
          )}
        >
          <SlidersHorizontal
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="font-medium">Setup options</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            <span>· optional</span>
            {!open && (
              <span className="hidden sm:inline">
                {" "}
                — the defaults work, open to fine-tune
              </span>
            )}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </UnstyledButton>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="divide-y px-4">
          {tools && (
            <Row
              label="Tools"
              summary={
                tools.gateways.find((g) => g.id === tools.selectedGatewayId)
                  ?.name ?? "No gateway"
              }
              control={
                tools.gateways.length > 1 ? (
                  <AgentSelector
                    mode="single"
                    flat
                    triggerLabel="Change"
                    agents={tools.gateways}
                    value={tools.selectedGatewayId}
                    onValueChange={tools.onGatewaySelect}
                    searchPlaceholder="Search gateways…"
                  />
                ) : null
              }
            />
          )}

          {proxy && (
            <Row
              label="Model routing"
              summary={
                proxyOn || proxy.mode === "unavailable"
                  ? proxySummary(proxy)
                  : `${clientLabel} keeps its current models`
              }
              toggle={{
                checked: proxyOn,
                onChange: proxy.setInclude,
                disabled: proxy.mode === "unavailable",
              }}
            >
              {proxyOn && (proxy.providerPicker || proxy.modelPicker) && (
                <div className="flex flex-wrap gap-2">
                  {proxy.providerPicker}
                  {proxy.modelPicker}
                </div>
              )}
            </Row>
          )}

          {skills && (
            <Row
              label="Skills"
              summary={skillsSummary(skills)}
              toggle={{
                checked: skills.include && skills.names.length > 0,
                onChange: skills.setInclude,
                disabled: skills.names.length === 0,
              }}
            />
          )}

          {plugins && (
            <Row
              label="Plugins"
              summary={
                pluginsOn
                  ? `${plugins.selectedIds.size} of ${plugins.all.length}`
                  : `None of ${plugins.all.length}`
              }
              toggle={{
                checked: pluginsOn,
                onChange: (on) =>
                  plugins.setSelectedIds(
                    new Set(on ? plugins.all.map((p) => p.id) : []),
                  ),
                disabled: plugins.all.length === 0,
              }}
            >
              {pluginsOn && <PluginPicker plugins={plugins} />}
            </Row>
          )}

          <Row
            label="Platform"
            summary="Shell for the command"
            control={platform}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// === Internal helpers ===

function Row({
  label,
  summary,
  toggle,
  control,
  children,
}: {
  label: string;
  summary: string;
  toggle?: {
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
  };
  control?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="py-1">
      <div className="flex min-h-8 items-center gap-3">
        {toggle ? (
          <Label htmlFor={id} className={LABEL_CLASS}>
            {label}
          </Label>
        ) : (
          <span className={LABEL_CLASS}>{label}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {summary}
        </span>
        {toggle && (
          <Switch
            id={id}
            checked={toggle.checked}
            onCheckedChange={toggle.onChange}
            disabled={toggle.disabled}
            className="shrink-0"
          />
        )}
        {control && <div className="min-w-0 shrink-0">{control}</div>}
      </div>
      {children && (
        <div className={cn(INDENT_CLASS, "pt-1 pb-1.5")}>{children}</div>
      )}
    </div>
  );
}

function PluginPicker({
  plugins,
}: {
  plugins: NonNullable<
    Parameters<typeof ConnectionConsentOptions>[0]["plugins"]
  >;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Grouping follows what was selected when the list opened, so rows don't
  // jump between groups while the user toggles them.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const { all, selectedIds, setSelectedIds } = plugins;

  const selected = useMemo(
    () => all.filter((p) => selectedIds.has(p.id)),
    [all, selectedIds],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.displayName.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [all, query]);
  const pinnedVisible = visible.filter((p) => pinned.has(p.id));
  const restVisible = visible.filter((p) => !pinned.has(p.id));

  const toggle = (plugin: PluginListItem) => {
    const next = new Set(selectedIds);
    if (next.has(plugin.id)) next.delete(plugin.id);
    else next.add(plugin.id);
    setSelectedIds(next);
  };
  const selectVisible = () =>
    setSelectedIds(new Set([...selectedIds, ...visible.map((p) => p.id)]));
  const clearVisible = () => {
    const hidden = new Set(visible.map((p) => p.id));
    setSelectedIds(new Set([...selectedIds].filter((id) => !hidden.has(id))));
  };

  const renderItem = (p: PluginListItem) => (
    <CommandItem
      key={p.id}
      value={p.id}
      onSelect={() => toggle(p)}
      className="mx-1 items-start gap-2.5 py-1.5"
    >
      <Checkbox
        checked={selectedIds.has(p.id)}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none mt-1"
      />
      <PluginTile plugin={p} className="size-6" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {p.displayName}
        </span>
        {p.description && (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {shorten(p.description, DESCRIPTION_LIMIT)}
          </span>
        )}
      </span>
    </CommandItem>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setPinned(new Set(selectedIds));
        else setQuery("");
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Choose plugins"
          className="w-full justify-between gap-2 font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selected.length > 0 && (
              <span className="flex shrink-0 -space-x-1.5">
                {selected.slice(0, ICON_STACK_LIMIT).map((p) => (
                  <PluginTile
                    key={p.id}
                    plugin={p}
                    className="size-5 ring-2 ring-background [&_svg]:size-3"
                  />
                ))}
              </span>
            )}
            <span className="truncate text-xs text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">
                {selected.length}
              </span>
              <span> of {all.length} plugins</span>
            </span>
          </span>
          <ChevronsUpDown
            aria-hidden
            className="size-3.5 text-muted-foreground"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[20rem] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search plugins…"
          />
          <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
            <span className="text-xs text-muted-foreground tabular-nums">
              {selected.length} of {all.length}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={selectVisible}
                disabled={visible.length === 0}
              >
                {query ? `All ${visible.length} shown` : "All"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={clearVisible}
                disabled={selected.length === 0}
              >
                None
              </Button>
            </div>
          </div>
          <CommandList className="max-h-80">
            <CommandEmpty>No plugins match.</CommandEmpty>
            {pinnedVisible.length > 0 && (
              <CommandGroup heading="Selected">
                {pinnedVisible.map(renderItem)}
              </CommandGroup>
            )}
            {restVisible.length > 0 && (
              <CommandGroup
                heading={pinnedVisible.length > 0 ? "Available" : undefined}
              >
                {restVisible.map(renderItem)}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// A fixed tile, so an owner avatar and the puzzle fallback share a footprint.
function PluginTile({
  plugin,
  className,
}: {
  plugin: PluginListItem;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted",
        "[&_[data-slot=avatar]]:size-full [&_[data-slot=avatar]]:rounded-none",
        className,
      )}
    >
      <PluginSourceGlyph plugin={plugin} />
    </span>
  );
}

function proxySummary(
  proxy: NonNullable<Parameters<typeof ConnectionConsentOptions>[0]["proxy"]>,
): string {
  const labels = proxy.providerLabels;
  const list = labels.join(", ") || "Your providers";
  switch (proxy.mode) {
    case "admin-key":
      return `${list} · key managed by your admin`;
    case "own-key":
      return proxy.providerPicker || labels.length !== 1
        ? "Your own key or subscription"
        : `Your own ${labels[0]} key or subscription`;
    case "all-providers":
      return `${list} · one virtual key, plus your own sign-ins`;
    case "per-user":
      return `Connect your own ${labels[0] ?? "provider"} account`;
    case "unavailable":
      return "No provider key available";
  }
}

function skillsSummary(
  skills: NonNullable<Parameters<typeof ConnectionConsentOptions>[0]["skills"]>,
): string {
  const { names, include } = skills;
  if (names.length === 0) return "None available";
  if (!include) return `${names.length} available, not installed`;
  const head = names.slice(0, 2).join(", ");
  const rest = names.length - 2;
  return rest > 0 ? `${head} +${rest}` : head;
}

function shorten(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit
    ? `${clean.slice(0, limit - 1).trimEnd()}…`
    : clean;
}

// A fixed label column, so every muted summary starts at the same left edge.
const LABEL_CLASS = "w-24 shrink-0 text-sm font-medium sm:w-28";
// Sub-controls line up under the summary column (label width + gap-3).
const INDENT_CLASS = "pl-[6.75rem] sm:pl-[7.75rem]";
const ICON_STACK_LIMIT = 5;
const DESCRIPTION_LIMIT = 120;
